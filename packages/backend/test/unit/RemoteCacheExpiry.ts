/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { MiRemoteFileCleanup } from '@/models/RemoteFileCleanup.js';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { DriveService } from '@/core/DriveService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import DriveChart from '@/core/chart/charts/drive.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import PerUserDriveChart from '@/core/chart/charts/per-user-drive.js';
import { MiDriveFile, MiUser, MiMeta } from '@/models/_.js';
import { CleanRemoteNoteFilesProcessorService } from '@/queue/processors/CleanRemoteNoteFilesProcessorService.js';
import type { QueueLoggerService } from '@/queue/QueueLoggerService.js';

describe('remote cache expiry accounting', () => {
	let app: TestingModule;
	let db: DataSource;
	let drive: DriveService;
	let worker: CleanRemoteNoteFilesProcessorService;
	let userId: string;
	const owned: string[] = [];
	const s3 = mockClient(S3Client);

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] }).compile();
		db = app.get(DI.db);
		drive = app.get(DriveService);
		const meta = app.get<MiMeta>(DI.meta);
		meta.enableChartsForFederatedInstances = true;
		meta.enableRemoteNotesCleaning = true;
		worker = new CleanRemoteNoteFilesProcessorService(db, meta, drive, { logger: { warn: vi.fn() } } as unknown as QueueLoggerService);
		userId = app.get(IdService).gen();
		await db.getRepository(MiUser).insert({ id: userId, username: userId, usernameLower: userId, host: 'remote.example' });
	});
	beforeEach(() => {
		s3.reset();
		s3.on(DeleteObjectCommand).resolves({});
		vi.spyOn(app.get(DriveChart), 'update').mockResolvedValue(undefined);
		vi.spyOn(app.get(InstanceChart), 'updateDrive').mockResolvedValue(undefined);
		vi.spyOn(app.get(PerUserDriveChart), 'update').mockResolvedValue(undefined);
		vi.spyOn(app.get(GlobalEventService), 'publishDriveStream').mockImplementation(() => {});
		vi.spyOn(drive, 'deleteFileStorage').mockResolvedValue(undefined);
		// Reference protection has dedicated tests; keep real GC/expiry transactions.
		vi.spyOn(worker, 'hasReferences').mockResolvedValue(false);
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await db.getRepository(MiRemoteFileCleanup).delete(owned);
		await db.getRepository(MiDriveFile).delete(owned);
		await db.getRepository(MiUser).delete(userId);
		s3.restore();
		await app.close();
	});

	async function file(overrides: Partial<MiDriveFile> = {}) {
		const id = app.get(IdService).gen();
		owned.push(id);
		await db.getRepository(MiDriveFile).insert({ id, userId, userHost: 'remote.example', name: 'cache', type: 'application/octet-stream', size: 100, md5: id, storedInternal: false, accessKey: id, url: 'https://remote/file', uri: 'https://remote/file', ...overrides });
		return db.getRepository(MiDriveFile).findOneByOrFail({ id });
	}

	async function collect(target: MiDriveFile) {
		await db.getRepository(MiRemoteFileCleanup).insert({ fileId: target.id });
		return worker.collect(target.id);
	}

	for (const size of [0, 100]) {
		test(`expiry then GC decrements a ${size}-byte cache once and preserves events`, async () => {
			const cached = await file({ size });
			await drive.deleteFileSync(cached, true);
			expect(await db.getRepository(MiDriveFile).findOneByOrFail({ id: cached.id })).toMatchObject({ isLink: true, isRemoteCacheExpired: true, size });
			expect(await app.get(DriveFileEntityService).pack(cached.id, { self: true })).not.toHaveProperty('isRemoteCacheExpired');
			expect(await collect(cached)).toBe('deleted');
			expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
			expect(app.get(InstanceChart).updateDrive).toHaveBeenCalledTimes(1);
			expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(2);
		});
	}

	for (const [kind, overrides, expected] of [
		['cached', {}, 1],
		['pure link', { isLink: true, size: 0 }, 1],
		['legacy expired link', { isLink: true, size: 100 }, 0],
		['local', { userHost: null, isLink: true, size: 100, isRemoteCacheExpired: true }, 1],
	] as const) {
		test(`${kind} preserves chart and event behavior`, async () => {
			const target = await file(overrides);
			await drive.deleteFileSync(target);
			expect(app.get(DriveChart).update).toHaveBeenCalledTimes(expected);
			expect(app.get(PerUserDriveChart).update).toHaveBeenCalledTimes(kind === 'local' ? 1 : 0);
			expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
		});
	}

	test('expiry between GC transactions accounts from the final deleted row', async () => {
		const cached = await file();
		vi.mocked(drive.deleteFileStorage).mockImplementationOnce(async descriptor => {
			expect(descriptor.isRemoteCacheExpired).toBe(false);
			await drive.deleteFileSync(cached, true);
		});
		expect(await collect(cached)).toBe('deleted');
		expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
		expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(2);
	});

	test('stale expiry after GC and repeated expiry emit no additional accounting', async () => {
		const deleted = await file();
		await collect(deleted);
		await drive.deleteFileSync(deleted, true);
		expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
		expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
		const cached = await file();
		await Promise.all([drive.deleteFileSync(cached, true), drive.deleteFileSync(cached, true)]);
		const expired = await db.getRepository(MiDriveFile).findOneByOrFail({ id: cached.id });
		await drive.deleteFileSync(expired, true);
		expect((await db.getRepository(MiDriveFile).findOneByOrFail({ id: cached.id })).accessKey).toBe(expired.accessKey);
		expect(app.get(DriveChart).update).toHaveBeenCalledTimes(2);
		expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(2);
	});

	test('deleting recovery retains storage keys but accounts from the expired row', async () => {
		const cached = await file({ size: 0 });
		vi.mocked(drive.deleteFileStorage).mockRejectedValueOnce(new Error('storage unavailable'));
		await expect(collect(cached)).rejects.toThrow('storage unavailable');
		await drive.deleteFileSync(cached, true);
		await db.getRepository(MiRemoteFileCleanup).update(cached.id, { nextAttemptAt: new Date(0) });
		expect(await worker.collect(cached.id)).toBe('deleted');
		expect(vi.mocked(drive.deleteFileStorage).mock.calls[1][0]).toMatchObject({ accessKey: cached.accessKey, isRemoteCacheExpired: false });
		expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
		expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(2);
	});
});
