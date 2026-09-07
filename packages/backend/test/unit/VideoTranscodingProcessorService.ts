/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs/promises';
import * as Path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { VideoTranscodingProcessorService } from '@/queue/processors/VideoTranscodingProcessorService.js';
import { TranscodeCancelledError } from '@/core/VideoTranscodingService.js';
import type { VideoTranscodingService } from '@/core/VideoTranscodingService.js';
import type { VideoTranscodingProgress, VideoTranscodingProgressService } from '@/core/VideoTranscodingProgressService.js';
import type { Config } from '@/config.js';
import type { DriveFilesRepository, MiDriveFile, MiMeta } from '@/models/_.js';
import type { MetaService } from '@/core/MetaService.js';
import type { DownloadService } from '@/core/DownloadService.js';
import type { InternalStorageService } from '@/core/InternalStorageService.js';
import type { S3Service } from '@/core/S3Service.js';
import type { FFmpegCapabilityService } from '@/core/FFmpegCapabilityService.js';
import type { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import type Logger from '@/logger.js';
import type { Job } from 'bullmq';
import type { VideoTranscodingJobData } from '@/queue/types.js';

vi.mock('@/core/MetaService.js', () => ({ MetaService: class {} }));
vi.mock('@/core/DownloadService.js', () => ({ DownloadService: class {} }));
vi.mock('@/core/InternalStorageService.js', () => ({ InternalStorageService: class {} }));
vi.mock('@/core/S3Service.js', () => ({ S3Service: class {} }));
vi.mock('@/core/LoggerService.js', () => ({ LoggerService: class {} }));
vi.mock('@/core/VideoTranscodingProgressService.js', () => ({ VideoTranscodingProgressService: class {} }));
vi.mock('@/queue/QueueLoggerService.js', () => ({ QueueLoggerService: class {} }));

afterEach(() => {
	vi.restoreAllMocks();
});

function harness(useObjectStorage = false, objectStoragePrefix = 'media') {
	const file = { id: 'video1', userId: 'user1', name: 'video.mp4', userHost: null, type: 'video/mp4', properties: {}, storedInternal: false, url: 'https://example.com/video.mp4' } as MiDriveFile;
	const repository = mock<DriveFilesRepository>();
	repository.findOneBy.mockResolvedValue(file);
	repository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });
	const meta = mock<MetaService>();
	meta.fetch.mockResolvedValue({ enableVideoTranscoding: true, videoTranscodeMaxFileSize: 0, videoTranscodeMaxDuration: 0, useObjectStorage, objectStoragePrefix, objectStorageBaseUrl: 'https://storage.example.com' } as MiMeta);
	const download = mock<DownloadService>();
	const storage = mock<InternalStorageService>();
	const s3 = mock<S3Service>();
	const caps = mock<FFmpegCapabilityService>();
	caps.getCapabilities.mockResolvedValue({ av1: true, hls: true, vvc: false } as Awaited<ReturnType<typeof caps.getCapabilities>>);
	const transcode = mock<VideoTranscodingService>();
	const progress = mock<VideoTranscodingProgressService>();
	progress.publishProgress.mockResolvedValue();
	const logger = mock<QueueLoggerService>();
	logger.logger = mock<Logger>();
	vi.mocked(logger.logger.createSubLogger).mockReturnValue(mock<Logger>());
	const service = new VideoTranscodingProcessorService({ url: 'https://example.com' } as Config, repository, meta, download, storage, s3, caps, transcode, progress, logger);
	const job = { data: { fileId: file.id }, opts: { attempts: 3 }, attemptsMade: 0 } as Job<VideoTranscodingJobData>;
	return { service, repository, storage, s3, transcode, progress, job };
}

describe('video transcoding worker', () => {
	test.each([false, true])('removes partially uploaded artifacts (S3: %s)', async (s3) => {
		const ctx = harness(s3);
		const stored = new Set<string>();
		ctx.transcode.transcode.mockImplementation(async ({ outDir }) => {
			await fs.writeFile(Path.join(outDir, 'first.m4s'), 'segment');
			await fs.writeFile(Path.join(outDir, 'second.m4s'), 'segment');
			return { variants: [], hasHls: true, hasDash: false };
		});
		const fail = new Error('storage unavailable');
		let writes = 0;
		ctx.storage.saveFromPath.mockImplementation((key) => {
			stored.add(key);
			if (++writes === 2) throw fail;
			return key;
		});
		ctx.s3.upload.mockImplementation(async (_meta, params) => {
			// Consume the real stream just as a storage upload does.
			for await (const _chunk of params.Body as AsyncIterable<Buffer>) { /* consume */ }
			stored.add(params.Key!);
			if (++writes === 2) throw fail;
			return { $metadata: {} };
		});
		ctx.storage.delPrefix.mockImplementation(prefix => { for (const key of stored) if (key.startsWith(`${prefix}/`)) stored.delete(key); });
		ctx.s3.deletePrefix.mockImplementation(async (_meta, prefix) => { for (const key of stored) if (key.startsWith(prefix)) stored.delete(key); });
		await expect(ctx.service.process(ctx.job)).rejects.toBe(fail);
		expect(writes).toBe(2);
		expect(stored.size).toBe(0);
		if (s3) expect(ctx.s3.deletePrefix).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^media\/stream-video1-[0-9a-f]+\/$/));
		else expect(ctx.storage.delPrefix).toHaveBeenCalledWith(expect.stringMatching(/^stream-video1-[0-9a-f]+$/));
		expect(ctx.repository.update).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transcodingStatus: 'completed' }));
	});

	test.each(['encode', 'upload'])('publishes terminal cancellation after delayed progress during %s', async (phase) => {
		const ctx = harness();
		const began = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const events: VideoTranscodingProgress['phase'][] = [];
		let active = false;
		ctx.progress.publishProgress.mockImplementation(async payload => {
			if (payload.phase === 'encoding-av1') {
				began.resolve();
				await release.promise;
			}
			events.push(payload.phase);
			active = payload.phase !== 'failed';
		});
		ctx.transcode.transcode.mockImplementation(async ({ onProgress }) => {
			onProgress!({ codec: 'av1', phase: 'encoding-av1', percent: 50 });
			await began.promise;
			if (phase === 'encode') throw new TranscodeCancelledError();
			return { variants: [], hasHls: true, hasDash: false };
		});
		ctx.repository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });
		const result = ctx.service.process(ctx.job);
		await began.promise;
		// The API removes the snapshot while a worker publication is still pending.
		active = false;
		release.resolve();
		await expect(result).resolves.toMatch(/^aborted: cancelled/);
		expect(events.at(-1)).toBe('failed');
		expect(active).toBe(false);
	});
});
