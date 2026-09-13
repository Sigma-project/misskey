/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export type FfprobeStream = {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
};

export type FfprobeData = {
	streams: FfprobeStream[];
	format: { duration?: number };
};

const execFileAsync = promisify(execFile);

/** Wait for ffprobe to exit, including after a timeout or output limit kills it. */
export async function ffprobe(path: string, options: { binary?: string; timeoutMs?: number } = {}): Promise<FfprobeData> {
	const candidates = options.binary != null ? [options.binary] : [
		...(process.env.FFPROBE_PATH ? [process.env.FFPROBE_PATH] : []),
		'ffprobe',
		...(process.env.FFMPEG_PATH ? [join(dirname(process.env.FFMPEG_PATH), 'ffprobe')] : []),
	];
	let lastError: unknown;
	for (const binary of new Set(candidates)) {
		let stdout: string;
		try {
			({ stdout } = await execFileAsync(binary, ['-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', '-i', path], {
				timeout: options.timeoutMs ?? 30 * 1000,
				killSignal: 'SIGKILL',
				maxBuffer: 4 * 1024 * 1024,
				encoding: 'utf8',
			}));
		} catch (error) {
			// A configured executable may be absent; failures from a running probe must not be retried.
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			lastError = error;
			continue;
		}

		const metadata = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { duration?: string | number } };
		const rawDuration = metadata.format?.duration;
		const duration = typeof rawDuration === 'string' && rawDuration.trim() !== '' ? Number(rawDuration) : rawDuration;
		return {
			streams: metadata.streams ?? [],
			format: { duration: typeof duration === 'number' && Number.isFinite(duration) ? duration : undefined },
		};
	}
	throw lastError;
}
