/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DataSource } from 'typeorm';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiRemoteFileCleanup } from '@/models/RemoteFileCleanup.js';
import { loadConfig } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import { api, castAsError, initTestDb, signup } from '../utils.js';
import type * as misskey from 'misskey-js';

describe('remote cleanup reference errors', () => {
	let db: DataSource;
	let alice: misskey.entities.SignupResponse;
	const ids = new IdService(loadConfig());
	beforeAll(async () => {
		db = await initTestDb(true);
		alice = await signup({ username: 'alice' });
	});
	afterAll(async () => { await db.destroy(); });

	const page = (name: string, fileId: string) => ({ title: name, name, content: [{ type: 'section', children: [{ type: 'image', fileId }] }], variables: [], script: '' });

	test('new missing Page JSON attachment returns a client error', async () => {
		const result = await api('pages/create', page('missing', ids.gen()), alice);
		expect(result.status).toBe(400);
		expect(castAsError(result.body).error.code).toBe('NO_SUCH_FILE');
	});

	test('unrelated database integrity errors remain server errors', async () => {
		await db.query(`CREATE FUNCTION test_unrelated_page_fk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unrelated foreign key failure' USING ERRCODE = '23503', CONSTRAINT = 'other_foreign_key'; END $$`);
		await db.query(`CREATE TRIGGER test_unrelated_page_fk BEFORE INSERT ON page FOR EACH ROW EXECUTE FUNCTION test_unrelated_page_fk()`);
		try {
			const result = await api('pages/create', { ...page('unrelated', ''), content: [] }, alice);
			expect(result.status).toBe(500);
			expect(castAsError(result.body).error.code).toBe('INTERNAL_ERROR');
		} finally {
			await db.query('DROP TRIGGER test_unrelated_page_fk ON page');
			await db.query('DROP FUNCTION test_unrelated_page_fk()');
		}
	});

	test('deleting references are rejected while a newly registered same-URI file is usable', async () => {
		const oldId = ids.gen();
		const newId = ids.gen();
		const uri = 'https://remote.example/shared-image';
		await db.getRepository(MiDriveFile).insert({ id: oldId, userId: alice.id, userHost: 'remote.example', md5: 'same-content', name: 'image', type: 'image/jpeg', size: 0, storedInternal: false, isLink: true, url: uri, uri });
		const old = await db.getRepository(MiDriveFile).findOneByOrFail({ id: oldId });
		await db.getRepository(MiRemoteFileCleanup).insert({ fileId: oldId, state: 'deleting', descriptor: old });
		const rejected = await api('pages/create', page('deleting', oldId), alice);
		expect(rejected.status).toBe(400);
		expect(castAsError(rejected.body).error.code).toBe('NO_SUCH_FILE');
		// The production schema deliberately has a non-unique URI index. A
		// retry descriptor cannot block re-registration during storage outages.
		await db.getRepository(MiDriveFile).insert({ ...old, id: newId });
		const accepted = await api('pages/create', page('replacement', newId), alice);
		expect(accepted.status).toBe(200);
		expect(await db.getRepository(MiRemoteFileCleanup).findOneBy({ fileId: oldId })).toMatchObject({ state: 'deleting' });
	});
});
