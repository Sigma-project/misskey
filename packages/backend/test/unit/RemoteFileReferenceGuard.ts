/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DataSource, EntitySchema } from 'typeorm';
import { loadConfig } from '@/config.js';
import { findReusableDriveFile } from '@/misc/find-reusable-drive-file.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { RemoteFileReferenceGuard1788783564794 } from '../../migration/1788783564794-RemoteFileReferenceGuard.js';
import type { QueryRunner } from 'typeorm';

describe('remote file reference guards', () => {
	const config = loadConfig();
	const schema = `file_guard_${randomUUID().replaceAll('-', '')}`;
	const migration = new RemoteFileReferenceGuard1788783564794();
	const fileEntity = new EntitySchema({ name: 'file', tableName: 'drive_file', schema, columns: {
		id: { type: String, primary: true },
		md5: { type: String },
		userId: { type: String },
		uri: { type: String },
	} });
	let db: DataSource;
	let writer: QueryRunner;
	let collector: QueryRunner;

	beforeAll(async () => {
		db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db, entities: [fileEntity] });
		await db.initialize();
		writer = db.createQueryRunner();
		collector = db.createQueryRunner();
		await writer.connect();
		await collector.connect();
		await writer.query(`CREATE SCHEMA "${schema}"`);
		for (const connection of [writer, collector]) await connection.query(`SET search_path TO "${schema}"`);
		await writer.query('CREATE TABLE drive_file (id varchar(32) PRIMARY KEY, md5 text, "userId" text, uri text)');
		await writer.query('CREATE TABLE remote_file_cleanup ("fileId" varchar(32) PRIMARY KEY, state varchar(16))');
		for (const table of ['note', 'note_draft', 'gallery_post', 'user', 'channel', 'chat_message', 'page']) {
			await writer.query(`CREATE TABLE "${table}" (id text PRIMARY KEY, "fileIds" text[], "fileId" text, "avatarId" text, "bannerId" text, "eyeCatchingImageId" text, content jsonb, variables jsonb)`);
		}
		await writer.query('ALTER TABLE note ADD COLUMN reactions jsonb, ADD COLUMN text text');
		await migration.up(writer);
	});

	beforeEach(async () => {
		await writer.query('TRUNCATE drive_file, remote_file_cleanup, note, note_draft, gallery_post, "user", channel, chat_message, page');
		await writer.query('INSERT INTO drive_file (id) VALUES (\'file\'), (\'other\')');
		await writer.query('INSERT INTO remote_file_cleanup VALUES (\'file\', \'pending\')');
	});

	afterAll(async () => {
		if (writer?.isTransactionActive) await writer.rollbackTransaction();
		if (collector?.isTransactionActive) await collector.rollbackTransaction();
		if (writer) {
			await migration.down(writer);
			await migration.up(writer);
			await migration.down(writer);
			await writer.query(`DROP SCHEMA "${schema}" CASCADE`);
			await writer.release();
		}
		if (collector) await collector.release();
		if (db?.isInitialized) await db.destroy();
	});

	test('extracts nested Page file IDs without treating freeform URLs as references', async () => {
		const [row] = await writer.query('SELECT remote_file_cleanup_json_ids($1::jsonb) AS ids', [JSON.stringify([
			{ type: 'section', children: [{ type: 'image', fileId: 'file' }] },
			{ fileIds: ['other', 'file', null, 3] },
			{ text: 'https://example.com/files/not-a-reference', fileId: null },
		])]);
		expect(row.ids).toEqual(['file', 'other']);
	});

	test('measures attachment-free note writes with unrelated payload', async () => {
		const reactions = JSON.stringify(Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`emoji-${index}`, index])));
		const started = performance.now();
		await writer.query(`INSERT INTO note (id, "fileIds", reactions, text)
			SELECT i::text, ARRAY[]::text[], $1::jsonb, repeat('note content ', 300) FROM generate_series(1, 5000) i`, [reactions]);
		console.info(`Attachment-free note insert: 5000 rows, ${Math.round(performance.now() - started)} ms`);
		expect((await writer.query('SELECT count(*)::integer AS count FROM note'))[0].count).toBe(5000);
	});

	test('skips the trigger for attachment-free inserts and unchanged reference updates', async () => {
		const [insert] = await writer.query(`EXPLAIN (ANALYZE, FORMAT JSON)
			INSERT INTO note (id, "fileIds") VALUES ('empty', ARRAY[]::text[])`);
		expect(insert['QUERY PLAN'][0].Triggers ?? []).toEqual([]);
		await writer.query('INSERT INTO note (id, "fileIds") VALUES (\'attached\', ARRAY[\'file\'])');
		const [update] = await writer.query(`EXPLAIN (ANALYZE, FORMAT JSON)
			UPDATE note SET "fileIds" = "fileIds" WHERE id = 'attached'`);
		expect(update['QUERY PLAN'][0].Triggers ?? []).toEqual([]);
	});

	test('does not interpret unrelated Note JSON as file references', async () => {
		await writer.query(`INSERT INTO note (id, "fileIds", reactions)
			VALUES ('attached', ARRAY['file'], '{"fileId":"not-a-file"}'::jsonb)`);
		await writer.query('UPDATE note SET "fileIds" = ARRAY[\'other\'] WHERE id = \'attached\'');
		expect((await writer.query('SELECT "fileIds" FROM note WHERE id = \'attached\''))[0].fileIds).toEqual(['other']);
	});

	test.each([
		['note', '"fileIds"', 'ARRAY[\'file\']'],
		['note_draft', '"fileIds"', 'ARRAY[\'file\']'],
		['gallery_post', '"fileIds"', 'ARRAY[\'file\']'],
		['user', '"avatarId"', '\'file\''],
		['user', '"bannerId"', '\'file\''],
		['channel', '"bannerId"', '\'file\''],
		['chat_message', '"fileId"', '\'file\''],
		['page', '"eyeCatchingImageId"', '\'file\''],
		['page', 'content', '\'[{"type":"section","children":[{"fileId":"file"}]}]\'::jsonb'],
		['page', 'variables', '\'[{"fileId":"file"}]\'::jsonb'],
	])('protects %s %s on insert and update', async (table, column, value) => {
		await writer.query(`INSERT INTO "${table}" (id, ${column}) VALUES ('existing', ${value})`);
		await writer.query('UPDATE remote_file_cleanup SET state = \'deleting\'');
		await expect(writer.query(`INSERT INTO "${table}" (id, ${column}) VALUES ('new', ${value})`)).rejects.toMatchObject({ code: '23503', constraint: 'remote_file_cleanup_reference_guard' });
		await writer.query(`INSERT INTO "${table}" (id) VALUES ('empty')`);
		await expect(writer.query(`UPDATE "${table}" SET ${column} = ${value} WHERE id = 'empty'`)).rejects.toMatchObject({ code: '23503', constraint: 'remote_file_cleanup_reference_guard' });
		// Unrelated edits of existing references do not introduce new references.
		await writer.query(`UPDATE "${table}" SET ${column} = ${value} WHERE id = 'existing'`);
	});

	test('rejects references after the collector has removed both rows', async () => {
		await writer.query('DELETE FROM drive_file');
		await writer.query('DELETE FROM remote_file_cleanup');
		await expect(writer.query('INSERT INTO note (id, "fileIds") VALUES (\'new\', ARRAY[\'file\'])')).rejects.toMatchObject({ code: '23503', constraint: 'remote_file_cleanup_reference_guard' });
	});

	test.each(['md5', 'uri'] as const)('does not reuse a deleting file by %s', async (column) => {
		await writer.query(`UPDATE drive_file SET "${column}" = 'match', "userId" = 'owner' WHERE id = 'file'`);
		const repository = writer.manager.getRepository(fileEntity) as unknown as DriveFilesRepository;
		const lookup = () => findReusableDriveFile(repository, { [column]: 'match', userId: 'owner' });
		await expect(lookup()).resolves.toMatchObject({ id: 'file' });
		await writer.query('UPDATE remote_file_cleanup SET state = \'deleting\'');
		await expect(lookup()).resolves.toBeNull();
		// A newly downloaded replacement can be reused while the old descriptor
		// remains durable for storage retries.
		await writer.query(`UPDATE drive_file SET "${column}" = 'match', "userId" = 'owner' WHERE id = 'other'`);
		await expect(lookup()).resolves.toMatchObject({ id: 'other' });
	});

	async function waitUntilBlocked(pid: number) {
		for (let attempt = 0; attempt < 500; attempt++) {
			const [row] = await db.query('SELECT cardinality(pg_blocking_pids($1)) AS count', [pid]);
			if (row.count > 0) return;
			await setTimeout(10);
		}
		throw new Error('Expected a database lock wait');
	}

	test('writer waits for deletion confirmation then observes its committed state', async () => {
		await collector.startTransaction();
		try {
			await collector.query('SELECT id FROM drive_file WHERE id = \'file\' FOR UPDATE');
			const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid');
			const inserting = writer.query('INSERT INTO note (id, "fileIds") VALUES (\'new\', ARRAY[\'file\'])');
			const rejected = expect(inserting).rejects.toMatchObject({ code: '23503', constraint: 'remote_file_cleanup_reference_guard' });
			await waitUntilBlocked(pid);
			await collector.query('UPDATE remote_file_cleanup SET state = \'deleting\'');
			await collector.commitTransaction();
			await rejected;
		} finally {
			if (collector.isTransactionActive) await collector.rollbackTransaction();
		}
	});

	test('collector waits for a writer commit and can then see the new reference', async () => {
		await writer.startTransaction();
		await collector.startTransaction();
		try {
			await writer.query('INSERT INTO note (id, "fileIds") VALUES (\'new\', ARRAY[\'file\'])');
			const [{ pid }] = await collector.query('SELECT pg_backend_pid() AS pid');
			const locking = collector.query('SELECT id FROM drive_file WHERE id = \'file\' FOR UPDATE');
			await waitUntilBlocked(pid);
			await writer.commitTransaction();
			await locking;
			const references = await collector.query('SELECT id FROM note WHERE "fileIds" @> ARRAY[\'file\']');
			expect(references).toEqual([{ id: 'new' }]);
			await collector.commitTransaction();
		} finally {
			if (writer.isTransactionActive) await writer.rollbackTransaction();
			if (collector.isTransactionActive) await collector.rollbackTransaction();
		}
	});
});
