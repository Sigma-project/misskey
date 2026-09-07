/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
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
		await expect(writer.query(`INSERT INTO "${table}" (id, ${column}) VALUES ('new', ${value})`)).rejects.toMatchObject({ code: '23503' });
		await writer.query(`INSERT INTO "${table}" (id) VALUES ('empty')`);
		await expect(writer.query(`UPDATE "${table}" SET ${column} = ${value} WHERE id = 'empty'`)).rejects.toMatchObject({ code: '23503' });
		// Unrelated edits of existing references do not introduce new references.
		await writer.query(`UPDATE "${table}" SET ${column} = ${value} WHERE id = 'existing'`);
	});

	test('rejects references after the collector has removed both rows', async () => {
		await writer.query('DELETE FROM drive_file');
		await writer.query('DELETE FROM remote_file_cleanup');
		await expect(writer.query('INSERT INTO note (id, "fileIds") VALUES (\'new\', ARRAY[\'file\'])')).rejects.toMatchObject({ code: '23503' });
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
			const rejected = expect(inserting).rejects.toMatchObject({ code: '23503' });
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
