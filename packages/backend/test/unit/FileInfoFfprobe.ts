/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { FileInfoService } from '@/core/FileInfoService.js';
import type { SensitiveMediaDetectionService } from '@/core/SensitiveMediaDetectionService.js';
import type { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { ffprobe } from '@/misc/ffprobe.js';

vi.mock('@/misc/ffprobe.js', () => ({ ffprobe: vi.fn() }));
vi.mock('@/core/SensitiveMediaDetectionService.js', () => ({ SensitiveMediaDetectionService: class {} }));
vi.mock('@/core/LoggerService.js', () => ({ LoggerService: class {} }));

let service: FileInfoService;
beforeEach(() => {
	vi.mocked(ffprobe).mockReset();
	const loggerService = mock<LoggerService>();
	const logger = mock<Logger>();
	logger.createSubLogger.mockReturnValue(logger);
	loggerService.getLogger.mockReturnValue(logger);
	service = new FileInfoService(mock<SensitiveMediaDetectionService>(), loggerService);
});

describe('FileInfoService ffprobe fallback', () => {
	test.each([
		new Error('timed out'),
		Object.assign(new Error('output limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
		Object.assign(new Error('missing binary'), { code: 'ENOENT' }),
		new SyntaxError('invalid metadata'),
	])('keeps upload processing possible after %s', async (error) => {
		vi.mocked(ffprobe).mockRejectedValue(error);
		await expect(service['hasVideoTrackOnVideoFile']('video.mp4')).resolves.toBe(true);
		await expect(service['getVideoInfo']('video.mp4')).resolves.toEqual({});
	});

	test('extracts video duration and codecs', async () => {
		vi.mocked(ffprobe).mockResolvedValue({
			streams: [{ codec_type: 'video', codec_name: 'av1' }, { codec_type: 'audio', codec_name: 'opus' }],
			format: { duration: 1.25 },
		});
		await expect(service['hasVideoTrackOnVideoFile']('video.mp4')).resolves.toBe(true);
		await expect(service['getVideoInfo']('video.mp4')).resolves.toEqual({ duration: 1.25, videoCodec: 'av1', audioCodec: 'opus' });
	});

	test('recognizes an audio-only container', async () => {
		vi.mocked(ffprobe).mockResolvedValue({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: {} });
		await expect(service['hasVideoTrackOnVideoFile']('audio.m4a')).resolves.toBe(false);
		await expect(service['getVideoInfo']('audio.m4a')).resolves.toEqual({ duration: undefined, videoCodec: undefined, audioCodec: 'aac' });
	});
});
