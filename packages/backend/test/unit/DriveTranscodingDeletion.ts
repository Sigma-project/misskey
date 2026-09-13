/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Test, type TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import type { Job } from 'bullmq';
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
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { VideoTranscodingProcessorService } from '@/queue/processors/VideoTranscodingProcessorService.js';
import DriveChart from '@/core/chart/charts/drive.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import PerUserDriveChart from '@/core/chart/charts/per-user-drive.js';
import { MiDriveFile, MiUser, MiMeta } from '@/models/_.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import type { MetaService } from '@/core/MetaService.js';
import type { DownloadService } from '@/core/DownloadService.js';
import type { FFmpegCapabilityService } from '@/core/FFmpegCapabilityService.js';
import type { VideoTranscodingService } from '@/core/VideoTranscodingService.js';
import type { VideoTranscodingProgressService } from '@/core/VideoTranscodingProgressService.js';
import type { VideoTranscodingJobData } from '@/queue/types.js';

describe('drive deletion racing with video transcoding', () => {
	let app: TestingModule;
	let db: DataSource;
	let drive: DriveService;
	let internal: InternalStorageService;
	let s3: S3Service;
	let userId: string;
	const owned: string[] = [];
	const stored = new Set<string>();

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] }).compile();
		db = app.get(DI.db);
		drive = app.get(DriveService);
		internal = app.get(InternalStorageService);
		s3 = app.get(S3Service);
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
			await Promise.all([drive[method](snapshot), drive[method](snapshot)]);
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
				await drive[method](snapshot);
				expect(stored.size).toBe(0);
				expect(internal.delPrefixAsync).toHaveBeenCalledWith(storedInternal ? latestPrefix : snapshot.transcodingPrefix);
				expect(s3.deletePrefix).toHaveBeenCalledWith(expect.anything(), `${storedInternal ? snapshot.transcodingPrefix : latestPrefix}/`);
			});
		}
	}

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
});
