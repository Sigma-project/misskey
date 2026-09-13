/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
import { QueueService } from '@/core/QueueService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { FFmpegCapabilityService } from '@/core/FFmpegCapabilityService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { VideoTranscodingProcessorService } from '@/queue/processors/VideoTranscodingProcessorService.js';
import CancelJob from '@/server/api/endpoints/admin/video-transcoding/cancel-job.js';
import { MiDriveFile, MiUser, MiMeta } from '@/models/_.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import type { MetaService } from '@/core/MetaService.js';
import type { DownloadService } from '@/core/DownloadService.js';
import type { InternalStorageService } from '@/core/InternalStorageService.js';
import type { S3Service } from '@/core/S3Service.js';
import type { VideoTranscodingService } from '@/core/VideoTranscodingService.js';
import type { VideoTranscodingProgressService } from '@/core/VideoTranscodingProgressService.js';
import type { VideoTranscodingQueue } from '@/core/QueueModule.js';
import type { VideoTranscodingJobData } from '@/queue/types.js';
import type { MiLocalUser } from '@/models/User.js';

const capabilities = { av1: true, hls: true, vvc: false, opus: false, dash: true };
const output = { variants: [], hasHls: false, hasDash: false };

describe('video transcoding state transitions', () => {
	let app: TestingModule;
	let db: DataSource;
	let repository: DriveFilesRepository;
	let drive: DriveService;
	let userId: string;
	const owned: string[] = [];

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] }).compile();
		db = app.get(DI.db);
		repository = app.get(DI.driveFilesRepository);
		drive = app.get(DriveService);
		userId = app.get(IdService).gen();
		await db.getRepository(MiUser).insert({ id: userId, username: userId, usernameLower: userId });
	});
	beforeEach(() => {
		Object.assign(app.get<MiMeta>(DI.meta), {
			enableVideoTranscoding: true, videoTranscodeMaxFileSize: 0,
			videoTranscodeMaxDuration: 0, useObjectStorage: false,
		});
		vi.spyOn(app.get(FFmpegCapabilityService), 'getCapabilities').mockResolvedValue(capabilities);
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await repository.delete(owned);
		await db.getRepository(MiUser).delete(userId);
		await app.close();
	});

	async function file(overrides: Partial<MiDriveFile> = {}) {
		const id = app.get(IdService).gen();
		owned.push(id);
		await repository.insert({
			id, userId, userHost: null, name: 'video.mp4', type: 'video/mp4',
			size: 100, md5: id, storedInternal: false, accessKey: id,
			url: 'https://storage.example/video.mp4', transcodingStatus: null,
			properties: { duration: 1 }, ...overrides,
		});
		return repository.findOneByOrFail({ id });
	}

	function worker(target: MiDriveFile, enabled = true) {
		const meta = mock<MetaService>();
		meta.fetch.mockResolvedValue({ ...app.get<MiMeta>(DI.meta), enableVideoTranscoding: enabled });
		const caps = mock<FFmpegCapabilityService>();
		caps.getCapabilities.mockResolvedValue(capabilities);
		const transcode = mock<VideoTranscodingService>();
		transcode.transcode.mockResolvedValue(output);
		const download = mock<DownloadService>();
		const progress = mock<VideoTranscodingProgressService>();
		progress.publishProgress.mockResolvedValue();
		const service = new VideoTranscodingProcessorService(
			app.get<Config>(DI.config), repository, meta, download,
			mock<InternalStorageService>(), mock<S3Service>(), caps, transcode, progress,
			new QueueLoggerService(app.get(LoggerService)),
		);
		const job = { data: { fileId: target.id }, opts: { attempts: 3 }, attemptsMade: 0 } as Job<VideoTranscodingJobData>;
		return { caps, transcode, download, progress, job, run: () => service.process(job) };
	}

	async function cancel(target: MiDriveFile) {
		const queue = mock<QueueService>();
		const jobs = mock<VideoTranscodingQueue>();
		const activeJob = mock<Job<VideoTranscodingJobData>>();
		activeJob.remove.mockRejectedValue(new Error('Job is locked'));
		jobs.getJob.mockResolvedValue(activeJob);
		queue.videoTranscodingQueue = jobs;
		const progress = mock<VideoTranscodingProgressService>();
		progress.remove.mockResolvedValue();
		const endpoint = new CancelJob(repository, queue, progress);
		await endpoint.exec({ fileId: target.id }, { id: userId } as MiLocalUser, null);
	}

	for (const initial of [null, 'pending', 'processing']) {
		test(`processes ${initial ?? 'legacy NULL'} with attemptsMade=0, including stalled recovery`, async () => {
			const target = await file({ transcodingStatus: initial });
			const ctx = worker(target);
			expect(await ctx.run()).toBe('Success');
			expect(ctx.transcode.transcode).toHaveBeenCalledOnce();
			expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: 'completed' });
		});
	}

	for (const terminal of ['failed', 'completed', 'skipped']) {
		for (const enabled of [false, true]) {
			test(`preserves ${terminal} and emits no progress when transcoding is ${enabled ? 'enabled' : 'disabled'}`, async () => {
				const target = await file({ transcodingStatus: terminal });
				const ctx = worker(target, enabled);
				await ctx.run();
				expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: terminal });
				expect(ctx.download.downloadUrl).not.toHaveBeenCalled();
				expect(ctx.transcode.transcode).not.toHaveBeenCalled();
				expect(ctx.progress.publishProgress).not.toHaveBeenCalled();
			});
		}
	}

	test('retries a failed attempt while its persisted state is still processing', async () => {
		const target = await file({ transcodingStatus: 'pending' });
		const ctx = worker(target);
		ctx.transcode.transcode.mockRejectedValueOnce(new Error('temporary encoder failure'));
		await expect(ctx.run()).rejects.toThrow('temporary encoder failure');
		expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: 'processing' });
		ctx.job.attemptsMade = 1;
		expect(await ctx.run()).toBe('Success');
		expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: 'completed' });
	});

	for (const enabled of [false, true]) {
		test(`preserves cancellation during capability lookup before ${enabled ? 'claiming' : 'skipping'}`, async () => {
			const target = await file();
			const ctx = worker(target, enabled);
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			ctx.caps.getCapabilities.mockImplementation(async () => {
				entered.resolve();
				await resume.promise;
				return capabilities;
			});
			const running = ctx.run();
			try {
				await entered.promise;
				await cancel(target);
				resume.resolve();
				await running;
				expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: 'failed' });
				expect(ctx.download.downloadUrl).not.toHaveBeenCalled();
				expect(ctx.transcode.transcode).not.toHaveBeenCalled();
				expect(ctx.progress.publishProgress).not.toHaveBeenCalled();
			} finally {
				resume.resolve();
				await running;
			}
		});
	}

	for (const nextState of ['processing', 'completed']) {
		test(`a final attempt only marks processing failed (current state: ${nextState})`, async () => {
			const target = await file();
			const ctx = worker(target);
			ctx.job.attemptsMade = 2;
			ctx.transcode.transcode.mockImplementation(async () => {
				await repository.update(target.id, { transcodingStatus: nextState });
				throw new Error('encoder failed');
			});
			await expect(ctx.run()).rejects.toThrow('encoder failed');
			expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: nextState === 'processing' ? 'failed' : nextState });
		});
	}

	for (const [kind, overrides, expected] of [
		['local video', {}, 'failed'],
		['remote video', { userHost: 'remote.example' }, null],
		['linked video', { isLink: true }, null],
		['non-video', { type: 'image/png' }, null],
		['pending video', { transcodingStatus: 'pending' }, 'failed'],
		['processing video', { transcodingStatus: 'processing' }, 'failed'],
		['completed video', { transcodingStatus: 'completed' }, 'completed'],
		['skipped video', { transcodingStatus: 'skipped' }, 'skipped'],
	] as const) {
		test(`cancellation accepts only eligible files: ${kind}`, async () => {
			const target = await file(overrides);
			await cancel(target);
			expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: expected });
		});
	}

	for (const ahead of [null, 'processing', 'completed', 'cancelled']) {
		test(`enqueue marks pending only after success and preserves an ahead-of-enqueue ${ahead ?? 'NULL'} state`, async () => {
			const target = await file();
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const settled = Promise.withResolvers<void>();
			const update = repository.update.bind(repository);
			vi.spyOn(repository, 'update').mockImplementation(async (...args) => {
				const result = await update(...args);
				if (args[1].transcodingStatus === 'pending') settled.resolve();
				return result;
			});
			vi.spyOn(app.get(QueueService), 'createVideoTranscodingJob').mockImplementation(async () => {
				entered.resolve();
				await resume.promise;
				return mock<Job<VideoTranscodingJobData>>();
			});
			drive['maybeEnqueueVideoTranscoding'](target);
			try {
				await entered.promise;
				expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: null });
				if (ahead === 'cancelled') await cancel(target);
				else if (ahead != null) await update(target.id, { transcodingStatus: ahead });
				resume.resolve();
				await settled.promise;
				expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: ahead === 'cancelled' ? 'failed' : ahead ?? 'pending' });
			} finally {
				resume.resolve();
				await settled.promise;
			}
		});
	}

	test('enqueue failure leaves NULL rather than a pending job that was never submitted', async () => {
		const target = await file();
		const logged = Promise.withResolvers<void>();
		vi.spyOn(drive['registerLogger'], 'warn').mockImplementation(() => { logged.resolve(); });
		vi.spyOn(app.get(QueueService), 'createVideoTranscodingJob').mockRejectedValueOnce(new Error('queue unavailable'));
		drive['maybeEnqueueVideoTranscoding'](target);
		await logged.promise;
		expect(await repository.findOneBy({ id: target.id })).toMatchObject({ transcodingStatus: null });
	});
});
