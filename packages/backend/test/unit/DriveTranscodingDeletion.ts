/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Test, type TestingModule } from '@nestjs/testing';
import { EntityManager, In, type DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DriveService } from '@/core/DriveService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { S3Service } from '@/core/S3Service.js';
import { QueueService } from '@/core/QueueService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { TranscodingCleanupService } from '@/core/TranscodingCleanupService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { VideoTranscodingProcessorService } from '@/queue/processors/VideoTranscodingProcessorService.js';
import DriveChart from '@/core/chart/charts/drive.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import PerUserDriveChart from '@/core/chart/charts/per-user-drive.js';
import { MiDriveFile, MiUser, MiMeta } from '@/models/_.js';
import { MiTranscodingCleanup } from '@/models/TranscodingCleanup.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import type { MetaService } from '@/core/MetaService.js';
import type { DownloadService } from '@/core/DownloadService.js';
import type { FFmpegCapabilityService } from '@/core/FFmpegCapabilityService.js';
import type { VideoTranscodingService } from '@/core/VideoTranscodingService.js';
import type { VideoTranscodingProgressService } from '@/core/VideoTranscodingProgressService.js';
import type { VideoTranscodingJobData } from '@/queue/types.js';
import type { Job } from 'bullmq';

describe('drive deletion racing with video transcoding', () => {
	let app: TestingModule;
	let db: DataSource;
	let drive: DriveService;
	let internal: InternalStorageService;
	let s3: S3Service;
	let cleanup: TranscodingCleanupService;
	let userId: string;
	const owned: string[] = [];
	const stored = new Set<string>();

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] }).compile();
		db = app.get(DI.db);
		drive = app.get(DriveService);
		internal = app.get(InternalStorageService);
		s3 = app.get(S3Service);
		cleanup = app.get(TranscodingCleanupService);
		userId = app.get(IdService).gen();
		await db.getRepository(MiUser).insert({ id: userId, username: userId, usernameLower: userId });
	});

	beforeEach(() => {
		stored.clear();
		vi.spyOn(app.get(DriveChart), 'update').mockResolvedValue(undefined);
		vi.spyOn(app.get(InstanceChart), 'updateDrive').mockResolvedValue(undefined);
		vi.spyOn(app.get(PerUserDriveChart), 'update').mockResolvedValue(undefined);
		vi.spyOn(app.get(GlobalEventService), 'publishDriveStream').mockImplementation(() => {});
		vi.spyOn(drive, 'deleteObjectStorageFile').mockResolvedValue();
		vi.spyOn(app.get(QueueService), 'createDeleteObjectStorageFileJob').mockResolvedValue(mock<Job>());
		vi.spyOn(internal, 'saveFromPath').mockImplementation(key => {
			stored.add(`internal:${key.split('/')[0]}`);
			return key;
		});
		vi.spyOn(internal, 'delPrefix').mockImplementation(prefix => { stored.delete(`internal:${prefix}`); });
		vi.spyOn(internal, 'delPrefixAsync').mockImplementation(async prefix => { stored.delete(`internal:${prefix}`); });
		vi.spyOn(s3, 'deletePrefix').mockImplementation(async (_meta, prefix) => { stored.delete(`s3:${prefix.slice(0, -1)}`); });
	});

	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await db.getRepository(MiTranscodingCleanup).delete({ fileId: In(owned) });
		await db.getRepository(MiDriveFile).delete(owned);
		await db.getRepository(MiUser).delete(userId);
		await app.close();
	});

	async function file(overrides: Partial<MiDriveFile> = {}) {
		const id = app.get(IdService).gen();
		owned.push(id);
		await db.getRepository(MiDriveFile).insert({
			id, userId, userHost: null, name: 'video.mp4', type: 'video/mp4',
			size: 100, md5: id, storedInternal: false, accessKey: id,
			url: 'https://storage.example/video.mp4', transcodingStatus: 'pending',
			properties: { duration: 1 }, ...overrides,
		});
		return db.getRepository(MiDriveFile).findOneByOrFail({ id });
	}

	function laterCollector() {
		return new TranscodingCleanupService(db, app.get<MiMeta>(DI.meta), app.get(IdService), internal, s3, app.get(LoggerService));
	}

	function worker(target: MiDriveFile) {
		const meta = mock<MetaService>();
		meta.fetch.mockResolvedValue({
			...app.get<MiMeta>(DI.meta), enableVideoTranscoding: true,
			videoTranscodeMaxFileSize: 0, videoTranscodeMaxDuration: 0, useObjectStorage: false,
		});
		const caps = mock<FFmpegCapabilityService>();
		caps.getCapabilities.mockResolvedValue({ av1: true, hls: true, vvc: false, opus: false, dash: true });
		const transcode = mock<VideoTranscodingService>();
		transcode.transcode.mockImplementation(async ({ outDir }) => {
			await writeFile(join(outDir, 'master.m3u8'), '#EXTM3U\n');
			return { variants: [], hasHls: true, hasDash: false };
		});
		const progress = mock<VideoTranscodingProgressService>();
		progress.publishProgress.mockResolvedValue();
		const processor = new VideoTranscodingProcessorService(
			app.get<Config>(DI.config), app.get<DriveFilesRepository>(DI.driveFilesRepository), meta, mock<DownloadService>(),
			internal, s3, caps, transcode, progress, new QueueLoggerService(app.get(LoggerService)),
		);
		const job = { data: { fileId: target.id }, opts: { attempts: 3 }, attemptsMade: 0 } as Job<VideoTranscodingJobData>;
		return { progress, run: () => processor.process(job) };
	}

	for (const method of ['deleteFile', 'deleteFileSync'] as const) {
		for (const isExpired of [false, true]) {
			test(`${method} rolls back ${isExpired ? 'expiry' : 'deletion'} when the outbox INSERT fails`, async () => {
				const snapshot = await file({
					userHost: isExpired ? 'remote.example' : null,
					uri: isExpired ? 'https://remote.example/video.mp4' : null,
					transcodingPrefix: 'retained-stream', transcodingStoredInternal: true,
				});
				vi.spyOn(cleanup, 'create').mockImplementationOnce(async manager => {
					// A real SQL error aborts the same transaction after its Drive DELETE/UPDATE.
					await manager.query('INSERT INTO "transcoding_cleanup" ("id") VALUES (NULL)');
					return null;
				});
				const collect = vi.spyOn(cleanup, 'collect');
				await expect(drive[method](snapshot, isExpired)).rejects.toThrow(/null value/);
				expect(await db.getRepository(MiDriveFile).findOneByOrFail({ id: snapshot.id })).toEqual(snapshot);
				expect(await db.getRepository(MiTranscodingCleanup).countBy({ fileId: snapshot.id })).toBe(0);
				expect(collect).not.toHaveBeenCalled();
				expect(internal.delPrefixAsync).not.toHaveBeenCalled();
				expect(app.get(GlobalEventService).publishDriveStream).not.toHaveBeenCalled();
				expect(app.get(DriveChart).update).not.toHaveBeenCalled();
				// Original storage deletion still precedes the database transaction.
				if (method === 'deleteFile') {
					expect(app.get(QueueService).createDeleteObjectStorageFileJob).toHaveBeenCalledWith(snapshot.accessKey);
				} else {
					expect(drive.deleteObjectStorageFile).toHaveBeenCalledWith(snapshot.accessKey);
				}
			});
		}

		test(`${method} reclaims a stream completed after the caller read the file`, async () => {
			const snapshot = await file();
			const processing = worker(snapshot);
			expect(await processing.run()).toBe('Success');
			const completed = await db.getRepository(MiDriveFile).findOneByOrFail({ id: snapshot.id });
			expect(stored.has(`internal:${completed.transcodingPrefix}`)).toBe(true);
			expect(snapshot.transcodingPrefix).toBeNull();

			await drive[method](snapshot);

			expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toBeNull();
			expect(stored.size).toBe(0);
			expect(internal.delPrefixAsync).toHaveBeenCalledWith(completed.transcodingPrefix);
			expect(app.get(DriveChart).update).toHaveBeenCalledWith(expect.objectContaining({ transcodingStatus: 'completed' }), false);
		});

		test(`${method} leaves a worker finishing after deletion to reclaim its output`, async () => {
			const snapshot = await file();
			const processing = worker(snapshot);
			const uploaded = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			processing.progress.publishProgress.mockImplementation(async payload => {
				if (payload.phase === 'uploading' && payload.percent === 100) {
					uploaded.resolve();
					await resume.promise;
				}
			});
			const running = processing.run();
			try {
				await uploaded.promise;
				expect(stored.size).toBe(1);
				await drive[method](snapshot);
				expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toBeNull();
				resume.resolve();
				expect(await running).toBe('aborted: cancelled or removed');
				expect(stored.size).toBe(0);
			} finally {
				resume.resolve();
				await running;
			}
		});

		test(`${method} notifies and accounts only once for repeated deletion`, async () => {
			const snapshot = await file();
			const collect = vi.spyOn(cleanup, 'collect');
			await Promise.all([drive[method](snapshot), drive[method](snapshot)]);
			expect(await db.getRepository(MiTranscodingCleanup).countBy({ fileId: snapshot.id })).toBe(0);
			expect(collect).not.toHaveBeenCalled();
			expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
			expect(app.get(PerUserDriveChart).update).toHaveBeenCalledTimes(1);
			expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
		});

		for (const storedInternal of [false, true]) {
			test(`${method} reclaims latest and stale variants across storage backends (latest internal: ${storedInternal})`, async () => {
				const snapshot = await file({ transcodingPrefix: 'previous-stream', transcodingStoredInternal: !storedInternal });
				const latestPrefix = 'current-stream';
				stored.add(`${storedInternal ? 's3' : 'internal'}:${snapshot.transcodingPrefix}`);
				stored.add(`${storedInternal ? 'internal' : 's3'}:${latestPrefix}`);
				await db.getRepository(MiDriveFile).update(snapshot.id, { transcodingPrefix: latestPrefix, transcodingStoredInternal: storedInternal });
				const collect = cleanup.collect;
				vi.spyOn(cleanup, 'collect').mockImplementationOnce(async id => {
					// A separate connection sees both descriptors only after the Drive transaction commits.
					expect(await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ id })).toMatchObject({
						fileId: snapshot.id,
						artifacts: [
							{ prefix: latestPrefix, storedInternal },
							{ prefix: snapshot.transcodingPrefix, storedInternal: !storedInternal },
						],
					});
					return collect(id);
				});
				await drive[method](snapshot);
				expect(stored.size).toBe(0);
				expect(internal.delPrefixAsync).toHaveBeenCalledWith(storedInternal ? latestPrefix : snapshot.transcodingPrefix);
				expect(s3.deletePrefix).toHaveBeenCalledWith(expect.anything(), `${storedInternal ? snapshot.transcodingPrefix : latestPrefix}/`, expect.any(AbortSignal));
			});
		}

		test(`${method} shares one S3 cleanup deadline for latest and stale variants`, async () => {
			const snapshot = await file({ transcodingPrefix: 'previous-stream', transcodingStoredInternal: false });
			await db.getRepository(MiDriveFile).update(snapshot.id, { transcodingPrefix: 'current-stream' });
			const controller = new AbortController();
			const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
			const warn = vi.spyOn(cleanup['logger'], 'warn').mockImplementation(() => {});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			vi.mocked(s3.deletePrefix).mockImplementation(async (_meta, _prefix, signal) => {
				entered.resolve();
				signal?.throwIfAborted();
				await Promise.race([
					release.promise,
					new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
				]);
			});
			let finished = false;
			const deleting = drive[method](snapshot).then(() => { finished = true; });
			try {
				await entered.promise;
				expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toBeNull();
				expect(finished).toBe(false);
				expect(deadline).toHaveBeenCalledOnce();
				expect(deadline.mock.calls[0][0]).toBeGreaterThan(0);
				expect(deadline.mock.calls[0][0]).toBeLessThanOrEqual(30 * 1000);
				expect(s3.deletePrefix).toHaveBeenNthCalledWith(1, expect.anything(), 'current-stream/', controller.signal);
				controller.abort();
				await deleting;
				expect(s3.deletePrefix).toHaveBeenCalledOnce();
				expect(deadline).toHaveBeenCalledTimes(1);
				expect(warn).toHaveBeenCalledTimes(2);
				expect(await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ fileId: snapshot.id })).toMatchObject({
					artifacts: [
						{ prefix: 'current-stream', storedInternal: false },
						{ prefix: 'previous-stream', storedInternal: false },
					],
					attempts: 1,
				});
				expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
				expect(app.get(PerUserDriveChart).update).toHaveBeenCalledTimes(1);
				expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
			} finally {
				controller.abort();
				// The old implementation has no signal; still release its pending mock on failure.
				release.resolve();
				await deleting;
			}
			expect(finished).toBe(true);
		});
	}

	for (const isExpired of [false, true]) {
		test(`a later collector recovers committed ${isExpired ? 'expiry' : 'deletion'} after inline cleanup is skipped`, async () => {
			const snapshot = await file({
				userHost: isExpired ? 'remote.example' : null,
				uri: isExpired ? 'https://remote.example/video.mp4' : null,
				transcodingPrefix: 'previous-stream', transcodingStoredInternal: false,
			});
			await db.getRepository(MiDriveFile).update(snapshot.id, { transcodingPrefix: 'current-stream', transcodingStoredInternal: true });
			stored.add('internal:current-stream');
			stored.add('s3:previous-stream');
			const collect = vi.spyOn(cleanup, 'collect').mockResolvedValue('deferred');
			await drive.deleteFileSync(snapshot, isExpired);
			const pending = await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ fileId: snapshot.id });
			expect(pending).toMatchObject({
				artifacts: [
					{ prefix: 'current-stream', storedInternal: true },
					{ prefix: 'previous-stream', storedInternal: false },
				],
				attempts: 0, lastError: null,
			});
			expect(collect).toHaveBeenCalledExactlyOnceWith(pending.id);
			expect(stored.size).toBe(2);
			expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
			if (isExpired) {
				expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toMatchObject({ isLink: true, isRemoteCacheExpired: true });
				expect(app.get(DriveChart).update).toHaveBeenCalledWith(expect.objectContaining({
					isLink: false, transcodingPrefix: 'current-stream', transcodingStoredInternal: true,
				}), false);
			} else {
				expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toBeNull();
			}

			// A fresh service needs only the durable record, even though the original caller is gone.
			expect(await laterCollector().collect(pending.id)).toBe('deleted');
			expect(await db.getRepository(MiTranscodingCleanup).findOneBy({ id: pending.id })).toBeNull();
			expect(stored.size).toBe(0);
			expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
		});

		test(`concurrent ${isExpired ? 'expiry' : 'deletion'} creates one durable record and one notification`, async () => {
			const snapshot = await file({
				userHost: isExpired ? 'remote.example' : null,
				uri: isExpired ? 'https://remote.example/video.mp4' : null,
				transcodingPrefix: 'retained-stream', transcodingStoredInternal: true,
			});
			const collect = vi.spyOn(cleanup, 'collect').mockResolvedValue('deferred');
			await Promise.all([drive.deleteFileSync(snapshot, isExpired), drive.deleteFileSync(snapshot, isExpired)]);
			expect(await db.getRepository(MiTranscodingCleanup).findBy({ fileId: snapshot.id })).toMatchObject([
				{ artifacts: [{ prefix: 'retained-stream', storedInternal: true }] },
			]);
			expect(collect).toHaveBeenCalledTimes(1);
			expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
			expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
		});
	}

	test('partial cleanup retains both storage descriptors until a later retry succeeds', async () => {
		const snapshot = await file({ transcodingPrefix: 'previous-stream', transcodingStoredInternal: false });
		await db.getRepository(MiDriveFile).update(snapshot.id, { transcodingPrefix: 'current-stream', transcodingStoredInternal: true });
		stored.add('internal:current-stream');
		stored.add('s3:previous-stream');
		const controller = new AbortController();
		const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		vi.spyOn(cleanup['logger'], 'warn').mockImplementation(() => {});
		vi.mocked(s3.deletePrefix).mockImplementationOnce(async (_meta, _prefix, signal) => {
			controller.abort(new Error('storage deadline reached'));
			signal?.throwIfAborted();
		});

		await drive.deleteFileSync(snapshot);
		expect(stored).toEqual(new Set(['s3:previous-stream']));
		const pending = await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ fileId: snapshot.id });
		expect(pending).toMatchObject({
			artifacts: [
				{ prefix: 'current-stream', storedInternal: true },
				{ prefix: 'previous-stream', storedInternal: false },
			],
			attempts: 1, lastError: expect.stringContaining('storage deadline reached'),
		});
		expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
		expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toBeNull();
		deadline.mockRestore();
		await db.getRepository(MiTranscodingCleanup).update(pending.id, { nextAttemptAt: new Date(0) });
		expect(await laterCollector().collect(pending.id)).toBe('deleted');
		expect(internal.delPrefixAsync).toHaveBeenCalledTimes(2);
		expect(s3.deletePrefix).toHaveBeenCalledTimes(2);
		expect(stored.size).toBe(0);
		expect(await db.getRepository(MiTranscodingCleanup).findOneBy({ id: pending.id })).toBeNull();
		expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
	});

	test('an outbox DELETE failure preserves notification and allows idempotent storage retry', async () => {
		const snapshot = await file({ transcodingPrefix: 'already-reclaimed-stream', transcodingStoredInternal: true });
		stored.add('internal:already-reclaimed-stream');
		const remove = vi.spyOn(EntityManager.prototype, 'delete').mockRejectedValueOnce(new Error('outbox delete unavailable'));
		const warn = vi.spyOn(drive['deleteLogger'], 'warn').mockImplementation(() => {});
		await drive.deleteFileSync(snapshot);
		const pending = await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ fileId: snapshot.id });
		expect(remove).toHaveBeenCalledExactlyOnceWith(MiTranscodingCleanup, pending.id);
		expect(warn).toHaveBeenCalledOnce();
		expect(stored.size).toBe(0);
		expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toBeNull();
		expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
		expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
		expect(await laterCollector().collect(pending.id)).toBe('deleted');
		expect(internal.delPrefixAsync).toHaveBeenCalledTimes(2);
		expect(await db.getRepository(MiTranscodingCleanup).findOneBy({ id: pending.id })).toBeNull();
		expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
	});

	test('deleteFile waits for internal stream deletion after committing the row deletion', async () => {
		const snapshot = await file({ transcodingPrefix: 'stream-to-await', transcodingStoredInternal: true });
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		vi.mocked(internal.delPrefixAsync).mockImplementation(async () => {
			entered.resolve();
			await resume.promise;
		});
		let finished = false;
		const deleting = drive.deleteFile(snapshot).then(() => { finished = true; });
		try {
			await entered.promise;
			expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toBeNull();
			expect(finished).toBe(false);
		} finally {
			resume.resolve();
			await deleting;
		}
		expect(finished).toBe(true);
	});

	test('deleteFileSync preserves the row and stream when original deletion fails', async () => {
		const snapshot = await file({ transcodingPrefix: 'retained-stream', transcodingStoredInternal: true });
		vi.mocked(drive.deleteObjectStorageFile).mockRejectedValueOnce(new Error('storage unavailable'));
		await expect(drive.deleteFileSync(snapshot)).rejects.toThrow('storage unavailable');
		expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toMatchObject({ transcodingPrefix: snapshot.transcodingPrefix });
		expect(internal.delPrefixAsync).not.toHaveBeenCalled();
		expect(app.get(DriveChart).update).not.toHaveBeenCalled();
		expect(app.get(GlobalEventService).publishDriveStream).not.toHaveBeenCalled();
	});

	test('remote expiry retains its row and accounts from the cached snapshot while deleting legacy streams', async () => {
		const snapshot = await file({
			userHost: 'remote.example', uri: 'https://remote.example/video.mp4',
			transcodingPrefix: 'legacy-stream', transcodingStoredInternal: true,
		});
		await drive.deleteFileSync(snapshot, true);
		expect(internal.delPrefixAsync).toHaveBeenCalledWith('legacy-stream');
		expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toMatchObject({ isLink: true, isRemoteCacheExpired: true });
		expect(app.get(DriveChart).update).toHaveBeenCalledWith(expect.objectContaining({ isRemoteCacheExpired: false, isLink: false }), false);
	});

	test('remote expiry proceeds after its S3 stream cleanup deadline', async () => {
		const snapshot = await file({
			userHost: 'remote.example', uri: 'https://remote.example/video.mp4',
			transcodingPrefix: 'legacy-stream', transcodingStoredInternal: false,
		});
		const controller = new AbortController();
		controller.abort();
		const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		const warn = vi.spyOn(cleanup['logger'], 'warn').mockImplementation(() => {});
		vi.mocked(s3.deletePrefix).mockImplementation(async (_meta, _prefix, signal) => {
			signal?.throwIfAborted();
		});
		await drive.deleteFileSync(snapshot, true);
		expect(deadline).toHaveBeenCalledOnce();
		expect(deadline.mock.calls[0][0]).toBeGreaterThan(0);
		expect(deadline.mock.calls[0][0]).toBeLessThanOrEqual(30 * 1000);
		expect(s3.deletePrefix).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ fileId: snapshot.id })).toMatchObject({
			artifacts: [{ prefix: 'legacy-stream', storedInternal: false }], attempts: 1,
		});
		expect(await db.getRepository(MiDriveFile).findOneBy({ id: snapshot.id })).toMatchObject({ isLink: true, isRemoteCacheExpired: true });
		expect(app.get(DriveChart).update).toHaveBeenCalledTimes(1);
		expect(app.get(GlobalEventService).publishDriveStream).toHaveBeenCalledTimes(1);
	});
});
