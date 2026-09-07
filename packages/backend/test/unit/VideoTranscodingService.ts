/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as Path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import FFmpeg from 'fluent-ffmpeg';
import { VideoTranscodingService, type TranscodingVariant } from '@/core/VideoTranscodingService.js';
import type { Config } from '@/config.js';
import type { FFmpegCapabilityService } from '@/core/FFmpegCapabilityService.js';
import type { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';

vi.mock('fluent-ffmpeg', () => ({ default: vi.fn() }));
vi.mock('@/core/LoggerService.js', () => ({ LoggerService: class {} }));

const dirs: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function harness() {
	const caps = mock<FFmpegCapabilityService>();
	caps.getCapabilities.mockResolvedValue({ av1: true, hls: true, vvc: true, opus: false } as Awaited<ReturnType<typeof caps.getCapabilities>>);
	const logger = mock<LoggerService>();
	logger.getLogger.mockReturnValue(mock<Logger>());
	return new VideoTranscodingService(mock<Config>(), caps, logger);
}

describe('video transcoding output cleanup', () => {
	test.each(['encode failure', 'unusable output'])('discards partial VVC files on %s before counting and uploading AV1', async (failure) => {
		const outDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'transcode-test-'));
		dirs.push(outDir);
		const service = harness();
		vi.spyOn(service as any, 'runHlsEncode').mockImplementation(async (...args: any[]) => {
			const opts = args[0];
			await fs.mkdir(Path.join(outDir, opts.codec));
			await fs.writeFile(Path.join(outDir, opts.codec, 'seg-001.m4s'), Buffer.alloc(opts.codec === 'av1' ? 10 : 100));
			if (opts.codec === 'vvc' && failure === 'encode failure') throw new Error('encoder failed');
		});
		vi.spyOn(service as any, 'collectVariant').mockImplementation(async (...args: any[]) => args[0] === 'av1'
			? { codec: 'av1', bitrate: 100, width: 16, height: 16, playlistPath: 'av1/playlist.m3u8' } as TranscodingVariant
			: null);
		vi.spyOn(service as any, 'buildDashManifest').mockResolvedValue('<MPD/>');
		const result = await service.transcode({ inputPath: 'input.mp4', outDir, durationSec: 1, maxOutputBytes: 50 });
		expect(result.variants.map(v => v.codec)).toEqual(['av1']);
		await expect(fs.stat(Path.join(outDir, 'vvc'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await fs.readFile(Path.join(outDir, 'av1', 'seg-001.m4s'))).toHaveLength(10);
	});
});

describe('video transcoding timeout', () => {
	test.each([0, NaN, -1, Infinity, 10])('keeps a bounded timeout for duration %s', async (durationSec) => {
		const outDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'transcode-timeout-'));
		dirs.push(outDir);
		vi.useFakeTimers();
		const callbacks = new Map<string, (...args: any[]) => void>();
		const started = Promise.withResolvers<void>();
		const command = {
			outputOptions: vi.fn().mockReturnThis(),
			output: vi.fn().mockReturnThis(),
			on: vi.fn((event: string, cb: (...args: any[]) => void) => { callbacks.set(event, cb); return command; }),
			run: vi.fn(() => started.resolve()),
			kill: vi.fn(() => callbacks.get('error')!(new Error('killed'))),
		};
		vi.mocked(FFmpeg).mockReturnValue(command as unknown as FFmpeg.FfmpegCommand);
		const service = harness();
		const encoding = service['runHlsEncode']({ codec: 'av1', inputPath: 'input.mp4', outDir, durationSec, audioCodec: 'aac', copyVideo: false });
		const rejected = expect(encoding).rejects.toThrow('ffmpeg timed out');
		await started.promise;
		await vi.advanceTimersByTimeAsync(60_001);
		expect(command.kill).not.toHaveBeenCalled();
		const timeout = durationSec === 10 ? 360_000 : 21_600_000;
		await vi.advanceTimersByTimeAsync(timeout - 60_002);
		expect(command.kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
		expect(command.kill).toHaveBeenCalledOnce();
	});
});
