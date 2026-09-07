/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { CleanRemoteNoteFilesProcessorService } from '@/queue/processors/CleanRemoteNoteFilesProcessorService.js';
import type { MiMeta } from '@/models/Meta.js';
import type { DriveService } from '@/core/DriveService.js';
import type { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { RemoteFileReferenceGuard1788783564794 } from '../../migration/1788783564794-RemoteFileReferenceGuard.js';
import { PageRemoteFileReferencesIndex1788784443305 } from '../../migration/1788784443305-PageRemoteFileReferencesIndex.js';
import type { QueryRunner } from 'typeorm';

vi.mock('@/core/DriveService.js', () => ({ DriveService: class {} }));
vi.mock('@/queue/QueueLoggerService.js', () => ({ QueueLoggerService: class {} }));

describe('remote cleanup reference queries', () => {
	const config = loadConfig();
	const schema = `file_refs_${randomUUID().replaceAll('-', '')}`;
	const migration = new RemoteFileReferenceGuard1788783564794();
	const indexMigration = new PageRemoteFileReferencesIndex1788784443305();
	let db: DataSource;
	let runner: QueryRunner;
	let service: CleanRemoteNoteFilesProcessorService;

	beforeAll(async () => {
		db = new DataSource({ type: 'postgres', host: config.db.host, port: config.db.port, username: config.db.user, password: config.db.pass, database: config.db.db });
		await db.initialize();
		runner = db.createQueryRunner();
		await runner.connect();
		await runner.query(`CREATE SCHEMA "${schema}"`);
		await runner.query(`SET search_path TO "${schema}"`);
		await runner.query('CREATE TABLE drive_file (id varchar(32) PRIMARY KEY)');
		await runner.query('CREATE TABLE remote_file_cleanup ("fileId" varchar(32) PRIMARY KEY, state varchar(16))');
		for (const table of ['note', 'note_draft', 'gallery_post', 'user', 'channel', 'chat_message', 'page']) {
			await runner.query(`CREATE TABLE "${table}" (id text PRIMARY KEY, "fileIds" varchar[], "fileId" varchar, "avatarId" varchar, "bannerId" varchar, "eyeCatchingImageId" varchar, content jsonb, variables jsonb)`);
		}
		// Match the existing production migration; do not add another Note index.
		await runner.query('CREATE INDEX "IDX_NOTE_FILE_IDS" ON note USING gin ("fileIds")');
		// Existing migration 1736686850345 and User's OneToOne relations.
		// Schema synchronization alone omits the synchronize:false Draft GIN.
		await runner.query('CREATE INDEX "IDX_NOTE_DRAFT_FILE_IDS" ON note_draft USING gin ("fileIds")');
		await runner.query('CREATE UNIQUE INDEX "REL_58f5c71eaab331645112cf8cfa" ON "user" ("avatarId")');
		await runner.query('CREATE UNIQUE INDEX "REL_afc64b53f8db3707ceb34eb28e" ON "user" ("bannerId")');
		await migration.up(runner);
		await indexMigration.up(runner);
		service = new CleanRemoteNoteFilesProcessorService(db, {} as MiMeta, {} as DriveService, {} as QueueLoggerService);
	});

	beforeEach(async () => {
		await runner.query('TRUNCATE drive_file, remote_file_cleanup, note, note_draft, gallery_post, "user", channel, chat_message, page');
		await runner.query('INSERT INTO drive_file VALUES (\'file\'), (\'other\')');
	});

	afterAll(async () => {
		if (!db.isInitialized) return;
		await indexMigration.down(runner);
		await indexMigration.up(runner);
		await indexMigration.down(runner);
		await migration.down(runner);
		await runner.query(`DROP SCHEMA "${schema}" CASCADE`);
		await runner.release();
		await db.destroy();
	});

	test.each([
		['note', '"fileIds"', 'ARRAY[\'file\']::varchar[]'],
		['note_draft', '"fileIds"', 'ARRAY[\'file\']::varchar[]'],
		['gallery_post', '"fileIds"', 'ARRAY[\'file\']::varchar[]'],
		['user', '"avatarId"', '\'file\''],
		['user', '"bannerId"', '\'file\''],
		['channel', '"bannerId"', '\'file\''],
		['chat_message', '"fileId"', '\'file\''],
		['page', '"eyeCatchingImageId"', '\'file\''],
		['page', 'content', '\'[{"type":"section","children":[{"fileId":"file"}]}]\'::jsonb'],
		['page', 'variables', '\'[{"value":{"fileId":"file"}}]\'::jsonb'],
	])('holds and releases %s %s references', async (table, column, value) => {
		await expect(service.hasReferences(runner.manager, 'file')).resolves.toBe(false);
		await runner.query(`INSERT INTO "${table}" (id, ${column}) VALUES ('reference', ${value})`);
		await expect(service.hasReferences(runner.manager, 'file')).resolves.toBe(true);
		await expect(service.hasReferences(runner.manager, 'other')).resolves.toBe(false);
		await runner.query(`UPDATE "${table}" SET ${column} = NULL WHERE id = 'reference'`);
		await expect(service.hasReferences(runner.manager, 'file')).resolves.toBe(false);
	});

	async function explainLookup(fileId: string) {
		const query = vi.spyOn(runner.manager, 'query');
		try {
			await service.hasReferences(runner.manager, fileId);
			const [sql, parameters] = query.mock.calls[0];
			const [{ 'QUERY PLAN': plan }] = await runner.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters);
			return JSON.stringify(plan);
		} finally {
			query.mockRestore();
		}
	}

	test('uses the existing Note GIN index for selective attachment lookups', async () => {
		await runner.query('INSERT INTO drive_file SELECT \'file-\' || i FROM generate_series(1, 10000) i');
		await runner.query('INSERT INTO note (id, "fileIds") SELECT id, ARRAY[id]::varchar[] FROM drive_file');
		await runner.query('ANALYZE note');
		expect(await explainLookup('file-9876')).toContain('IDX_NOTE_FILE_IDS');
		await expect(service.hasReferences(runner.manager, 'file-9876')).resolves.toBe(true);
	});

	test('uses the existing Draft GIN index for reference misses and hits', async () => {
		await runner.query('INSERT INTO drive_file SELECT \'draft-file-\' || i FROM generate_series(1, 10000) i');
		await runner.query('INSERT INTO note_draft (id, "fileIds") SELECT id, ARRAY[id]::varchar[] FROM drive_file');
		await runner.query('ANALYZE note_draft');
		expect(await explainLookup('missing-candidate')).toContain('IDX_NOTE_DRAFT_FILE_IDS');
		expect(await explainLookup('draft-file-9876')).toContain('IDX_NOTE_DRAFT_FILE_IDS');
		await expect(service.hasReferences(runner.manager, 'draft-file-9876')).resolves.toBe(true);
		const started = performance.now();
		for (let index = 0; index < 100; index++) await service.hasReferences(runner.manager, `candidate-${index}`);
		console.info(`Draft indexed: 100 candidates, 10000 rows, ${Math.round(performance.now() - started)} ms`);
	});

	test('uses both existing User unique indexes at 100000 users', async () => {
		await runner.query(`INSERT INTO drive_file SELECT prefix || i FROM generate_series(1, 100000) i CROSS JOIN unnest(ARRAY['avatar-', 'banner-']) prefix`);
		await runner.query(`INSERT INTO "user" (id, "avatarId", "bannerId")
			SELECT i::text, 'avatar-' || i, 'banner-' || i FROM generate_series(1, 100000) i`);
		await runner.query('ANALYZE "user"');
		for (const fileId of ['missing-candidate', 'avatar-9876', 'banner-9876']) {
			const plan = await explainLookup(fileId);
			expect(plan).toContain('REL_58f5c71eaab331645112cf8cfa');
			expect(plan).toContain('REL_afc64b53f8db3707ceb34eb28e');
		}
		await expect(service.hasReferences(runner.manager, 'avatar-9876')).resolves.toBe(true);
		await expect(service.hasReferences(runner.manager, 'banner-9876')).resolves.toBe(true);
		const started = performance.now();
		for (let index = 0; index < 100; index++) await service.hasReferences(runner.manager, `candidate-${index}`);
		console.info(`User indexed: 100 candidates, 100000 rows, ${Math.round(performance.now() - started)} ms`);
	});

	test('measures a worker batch against nested Page references', async () => {
		await runner.query(`INSERT INTO page (id, content, variables)
			SELECT i::text, '[{"type":"section","children":[{"type":"image","fileId":"other"},{"type":"text","text":"example"}]}]'::jsonb,
			'[{"value":{"fileId":"other"}}]'::jsonb FROM generate_series(1, 1000) i`);
		await runner.query('ANALYZE page');
		expect(await explainLookup('missing-candidate')).toContain('IDX_PAGE_REMOTE_FILE_REFERENCES');
		const started = performance.now();
		for (let index = 0; index < 100; index++) {
			await expect(service.hasReferences(runner.manager, `candidate-${index}`)).resolves.toBe(false);
		}
		console.info(`Page reference indexed: 100 candidates, 1000 Pages, ${Math.round(performance.now() - started)} ms`);
	});

	test.each([
		['chat_message', '"fileId"', '\'other\'', 100000],
		['gallery_post', '"fileIds"', 'ARRAY[\'other\']::varchar[]', 10000],
		['channel', '"bannerId"', '\'other\'', 10000],
	] as const)('measures %s reference lookup cost', async (table, column, value, rows) => {
		await runner.query(`INSERT INTO "${table}" (id, ${column}) SELECT i::text, ${value} FROM generate_series(1, ${rows}) i`);
		await runner.query(`ANALYZE "${table}"`);
		const started = performance.now();
		for (let index = 0; index < 100; index++) {
			await expect(service.hasReferences(runner.manager, `candidate-${index}`)).resolves.toBe(false);
		}
		console.info(`${table} reference baseline: 100 candidates, ${rows} rows, ${Math.round(performance.now() - started)} ms`);
	});
});
