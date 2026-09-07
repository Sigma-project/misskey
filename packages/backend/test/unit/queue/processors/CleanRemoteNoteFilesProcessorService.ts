/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteFileReferenceGuard1788783564794 } from '../../../../migration/1788783564794-RemoteFileReferenceGuard.js';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { MiMeta } from '@/models/Meta.js';
import { MiUser } from '@/models/User.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiRemoteFileCleanup } from '@/models/RemoteFileCleanup.js';
import { DriveService } from '@/core/DriveService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { IdService } from '@/core/IdService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { CleanRemoteNoteFilesProcessorService } from '@/queue/processors/CleanRemoteNoteFilesProcessorService.js';
import type { Config } from '@/config.js';

describe('CleanRemoteNoteFilesProcessorService', () => {
	let app: TestingModule;
	let db: DataSource;
	let service: CleanRemoteNoteFilesProcessorService;
	let ids: IdService;
	const meta = new MiMeta();
	const drive = { deleteFileStorage: vi.fn(), notifyFileDeleted: vi.fn() };
	const logger = { info: vi.fn(), warn: vi.fn(), createSubLogger: () => logger };
	const owned: string[] = [];

	async function candidate(overrides: Partial<MiDriveFile> = {}) {
		const id = ids.gen();
		owned.push(id);
		await db.getRepository(MiDriveFile).insert({ id, userHost: 'remote.example', md5: id, name: 'file', type: 'image/jpeg', size: 1, storedInternal: false, isLink: true, url: 'https://remote/file', ...overrides });
		await db.getRepository(MiRemoteFileCleanup).insert({ fileId: id });
		return db.getRepository(MiDriveFile).findOneByOrFail({ id });
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule], providers: [
			CleanRemoteNoteFilesProcessorService, IdService,
			{ provide: DriveService, useValue: drive },
			{ provide: QueueLoggerService, useValue: { logger } },
		] }).overrideProvider(DI.meta).useValue(meta).compile();
		db = app.get(DI.db);
		await new RemoteFileReferenceGuard1788783564794().up(db);
		ids = app.get(IdService);
		service = app.get(CleanRemoteNoteFilesProcessorService);
	});
	beforeEach(() => {
		meta.enableRemoteNotesCleaning = true;
		drive.deleteFileStorage.mockReset().mockResolvedValue(undefined);
		drive.notifyFileDeleted.mockReset().mockResolvedValue(undefined);
	});
	afterAll(async () => {
		if (owned.length) {
			await db.getRepository(MiRemoteFileCleanup).delete(owned);
			await db.getRepository(MiDriveFile).delete(owned);
		}
		await new RemoteFileReferenceGuard1788783564794().down(db);
		await app.close();
	});

	test('link-only candidates are removed once, without repeat notifications', async () => {
		const file = await candidate();
		expect(await service.collect(file.id)).toBe('deleted');
		expect(await db.getRepository(MiDriveFile).findOneBy({ id: file.id })).toBeNull();
		expect(await db.getRepository(MiRemoteFileCleanup).findOneBy({ fileId: file.id })).toBeNull();
		await service.collect(file.id);
		expect(drive.notifyFileDeleted).toHaveBeenCalledTimes(1);
		expect(drive.deleteFileStorage).toHaveBeenCalledTimes(1);
	});

	test('local ownership and disabled cleanup protect pending files', async () => {
		const local = await candidate({ userHost: null });
		await service.collect(local.id);
		expect(await db.getRepository(MiDriveFile).findOneBy({ id: local.id })).not.toBeNull();
		const remote = await candidate();
		meta.enableRemoteNotesCleaning = false;
		await service.collect(remote.id);
		expect(await db.getRepository(MiRemoteFileCleanup).findOneBy({ fileId: remote.id })).toMatchObject({ state: 'pending' });
		expect(drive.deleteFileStorage).not.toHaveBeenCalled();
	});

	test('shared references postpone without losing the candidate and collect after release', async () => {
		const file = await candidate();
		const userId = ids.gen();
		await db.getRepository(MiUser).insert({ id: userId, username: userId, usernameLower: userId, avatarId: file.id });
		try {
			expect(await service.collect(file.id)).toBe('deferred');
			expect(drive.deleteFileStorage).not.toHaveBeenCalled();
			expect(await db.getRepository(MiRemoteFileCleanup).findOneBy({ fileId: file.id })).toMatchObject({ state: 'pending', attempts: 1 });
			await db.getRepository(MiUser).update(userId, { avatarId: null });
			await db.getRepository(MiRemoteFileCleanup).update(file.id, { nextAttemptAt: new Date(0) });
			expect(await service.collect(file.id)).toBe('deleted');
		} finally { await db.getRepository(MiUser).delete(userId); }
	});

	test('partial failure retains keys and retries deleting state even when disabled', async () => {
		const file = await candidate({ storedInternal: true, isLink: false, accessKey: randomUUID(), thumbnailAccessKey: randomUUID(), transcodingPrefix: randomUUID(), transcodingStoredInternal: true });
		drive.deleteFileStorage.mockRejectedValueOnce(new Error('disk unavailable'));
		await expect(service.collect(file.id)).rejects.toThrow('disk unavailable');
		const pending = await db.getRepository(MiRemoteFileCleanup).findOneByOrFail({ fileId: file.id });
		expect(pending).toMatchObject({ state: 'deleting', attempts: 1, descriptor: { accessKey: file.accessKey, thumbnailAccessKey: file.thumbnailAccessKey, transcodingPrefix: file.transcodingPrefix } });
		expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
		await db.getRepository(MiRemoteFileCleanup).update(file.id, { nextAttemptAt: new Date(0) });
		meta.enableRemoteNotesCleaning = false;
		await service.process();
		expect(await db.getRepository(MiRemoteFileCleanup).findOneBy({ fileId: file.id })).toBeNull();
		expect(drive.notifyFileDeleted).toHaveBeenCalledTimes(1);
	});

	test('second worker cannot delete or notify during storage I/O', async () => {
		const file = await candidate();
		let resume!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		drive.deleteFileStorage.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { resume = resolve; }); });
		const first = service.collect(file.id);
		await started;
		try { expect(await service.collect(file.id)).toBe('skipped'); } finally { resume(); }
		await first;
		expect(drive.deleteFileStorage).toHaveBeenCalledTimes(1);
		expect(drive.notifyFileDeleted).toHaveBeenCalledTimes(1);
	});

	test('deleting descriptor survives another path removing the Drive row', async () => {
		const file = await candidate({ accessKey: randomUUID() });
		await db.getRepository(MiRemoteFileCleanup).update(file.id, { state: 'deleting', descriptor: file });
		await db.getRepository(MiDriveFile).delete(file.id);
		await service.collect(file.id);
		expect(drive.deleteFileStorage).toHaveBeenCalledWith(expect.objectContaining({ accessKey: file.accessKey }));
		expect(drive.notifyFileDeleted).not.toHaveBeenCalled();
	});

	test('failed final DB deletion retains deleting state and retries without duplicate notification', async () => {
		const file = await candidate();
		await db.query(`CREATE FUNCTION test_reject_drive_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'finalization failed'; END $$`);
		await db.query(`CREATE TRIGGER test_reject_drive_cleanup BEFORE DELETE ON drive_file FOR EACH ROW EXECUTE FUNCTION test_reject_drive_cleanup()`);
		try {
			await expect(service.collect(file.id)).rejects.toThrow('finalization failed');
			expect(await db.getRepository(MiRemoteFileCleanup).findOneBy({ fileId: file.id })).toMatchObject({ state: 'deleting', descriptor: { id: file.id } });
			expect(await db.getRepository(MiDriveFile).findOneBy({ id: file.id })).not.toBeNull();
			expect(drive.notifyFileDeleted).not.toHaveBeenCalled();
		} finally {
			await db.query('DROP TRIGGER test_reject_drive_cleanup ON drive_file');
			await db.query('DROP FUNCTION test_reject_drive_cleanup()');
		}
		await db.getRepository(MiRemoteFileCleanup).update(file.id, { nextAttemptAt: new Date(0) });
		await service.collect(file.id);
		expect(drive.deleteFileStorage).toHaveBeenCalledTimes(2);
		expect(drive.notifyFileDeleted).toHaveBeenCalledTimes(1);
	});

	test('missing pending rows finish without issuing a storage delete', async () => {
		const file = await candidate();
		await db.getRepository(MiDriveFile).delete(file.id);
		await service.collect(file.id);
		expect(await db.getRepository(MiRemoteFileCleanup).findOneBy({ fileId: file.id })).toBeNull();
		expect(drive.deleteFileStorage).not.toHaveBeenCalled();
		expect(drive.notifyFileDeleted).not.toHaveBeenCalled();
	});

	test('notification failure cannot repeat a committed deletion', async () => {
		const file = await candidate();
		drive.notifyFileDeleted.mockRejectedValueOnce(new Error('redis unavailable'));
		expect(await service.collect(file.id)).toBe('deleted');
		await service.collect(file.id);
		expect(drive.deleteFileStorage).toHaveBeenCalledTimes(1);
	});

	test('internal storage awaits all artifacts and propagates errors other than ENOENT', async () => {
		const root = await mkdtemp(join(tmpdir(), 'misskey-cleanup-'));
		try {
			const storage = new InternalStorageService({ rootDir: root } as Config);
			await mkdir(join(root, 'files', 'stream'), { recursive: true });
			await writeFile(join(root, 'files', 'original'), 'test');
			await writeFile(join(root, 'files', 'stream', 'segment'), 'test');
			await storage.delAsync('original');
			await expect(access(join(root, 'files', 'original'))).rejects.toThrow();
			await storage.delAsync('original');
			await expect(storage.delAsync('stream')).rejects.toThrow();
			await storage.delPrefixAsync('stream');
			await expect(access(join(root, 'files', 'stream'))).rejects.toThrow();
			await expect(storage.delPrefixAsync('.')).rejects.toThrow('Invalid storage prefix');
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
