/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DataSource } from 'typeorm';
import { RemoteFileReferenceGuard1788783564794 } from '../migration/1788783564794-RemoteFileReferenceGuard.js';
import { beforeAll, afterAll } from 'vitest';
import { initTestDb, sendEnvResetRequest } from './utils.js';

let referenceGuardDb: DataSource;
const referenceGuardMigration = new RemoteFileReferenceGuard1788783564794();

beforeAll(async () => {
	// 前ファイルのNestJSアプリをdispose(env-reset)した後にスキーマをdrop & 再作成する。
	// 逆順だと、前ファイルの最後のテストが投げっぱなしにした非同期処理(cacheServiceのrefresh等)が
	// dispose前のdrop中に発火し、Unhandled Rejection (relation does not exist) でクラッシュしうる。
	await sendEnvResetRequest();
	referenceGuardDb = await initTestDb(false);
	// synchronize cannot create trigger-based constraints; exercise the same
	// reference handshake as production for every API integration suite.
	// A prior interrupted suite can leave functions after dropSchema removed tables.
	await referenceGuardDb.query('DROP FUNCTION IF EXISTS remote_file_cleanup_guard() CASCADE');
	await referenceGuardDb.query('DROP FUNCTION IF EXISTS remote_file_cleanup_json_ids(jsonb)');
	await referenceGuardMigration.up(referenceGuardDb);
});

afterAll(async () => {
	if (referenceGuardDb?.isInitialized) {
		try {
			// Some suites start a second Nest application, whose test DataSource
			// drops the tables. Test-only cleanup also tolerates those removed triggers.
			await referenceGuardDb.query('DROP FUNCTION IF EXISTS remote_file_cleanup_guard() CASCADE');
			await referenceGuardDb.query('DROP FUNCTION IF EXISTS remote_file_cleanup_json_ids(jsonb)');
		} finally { await referenceGuardDb.destroy(); }
	}
});
