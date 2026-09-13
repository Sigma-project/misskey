/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ffprobe } from '@/misc/ffprobe.js';

let dir: string;
let input: string;
let pidPath: string;
let argsPath: string;
let fixture: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'ffprobe-test-'));
	input = join(dir, 'input with spaces; $(touch unexpected).json');
	pidPath = join(dir, 'pid');
	argsPath = join(dir, 'args.json');
	fixture = `#!${process.execPath}\n${await readFile(new URL('../resources/ffprobe-fixture.mjs', import.meta.url), 'utf8')}`;
	vi.stubEnv('FFPROBE_PATH', undefined);
	vi.stubEnv('FFMPEG_PATH', undefined);
	vi.stubEnv('PATH', dir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	// Also clean up a surviving child if an assertion detects a regression.
	try {
		const pid = Number(await readFile(pidPath, 'utf8'));
		if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
	} catch (error) {
		if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function executable(path = join(dir, 'ffprobe')): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, fixture, { mode: 0o755 });
	return path;
}

async function configure(mode = 'normal', data: unknown = { streams: [], format: {} }): Promise<void> {
	await writeFile(input, JSON.stringify({ mode, data, pidPath, argsPath }));
}

async function expectExited(): Promise<void> {
	const pid = Number(await readFile(pidPath, 'utf8'));
	expect(pid).toBeGreaterThan(0);
	expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}

describe('ffprobe process bounds', () => {
	test('parses metadata and passes the file path as one literal argument', async () => {
		const binary = await executable();
		const streams = [
			{ codec_type: 'video', codec_name: 'av1', width: 1920, height: 1080 },
			{ codec_type: 'audio', codec_name: 'opus' },
		];
		await configure('normal', { streams, format: { duration: '1.250000' } });
		await expect(ffprobe(input, { binary })).resolves.toEqual({ streams, format: { duration: 1.25 } });
		expect(JSON.parse(await readFile(argsPath, 'utf8'))).toEqual(['-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', '-i', input]);
		await expectExited();
	});

	test.each([
		[2.5, 2.5],
		['0', 0],
		['N/A', undefined],
		['Infinity', undefined],
		['NaN', undefined],
		['', undefined],
		[' ', undefined],
		[undefined, undefined],
	])('normalizes duration %j to %j', async (duration, expected) => {
		await executable();
		await configure('normal', { streams: [], format: { duration } });
		expect((await ffprobe(input)).format.duration).toBe(expected);
	});

	test('kills and reaps a hanging process before rejecting the timeout', async () => {
		await executable();
		await configure('hang');
		await expect(ffprobe(input, { timeoutMs: 1000 })).rejects.toMatchObject({ killed: true, signal: 'SIGKILL' });
		await expectExited();
	});

	test.each(['stdout', 'stderr'])('kills and reaps a process exceeding the default %s limit', async (output) => {
		await executable();
		await configure(`overflow-${output}`);
		await expect(ffprobe(input)).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
		await expectExited();
	});

	test('rejects a nonzero exit', async () => {
		await executable();
		await configure('nonzero');
		await expect(ffprobe(input)).rejects.toMatchObject({ code: 1, stderr: 'ffprobe fixture failed' });
		await expectExited();
	});

	test('rejects malformed JSON', async () => {
		await executable();
		await configure('malformed');
		await expect(ffprobe(input)).rejects.toBeInstanceOf(SyntaxError);
		await expectExited();
	});
});

describe('ffprobe executable resolution', () => {
	test('prefers FFPROBE_PATH over PATH', async () => {
		vi.stubEnv('FFPROBE_PATH', await executable(join(dir, 'custom', 'probe')));
		await writeFile(join(dir, 'ffprobe'), 'not executable');
		await configure();
		await expect(ffprobe(input)).resolves.toMatchObject({ streams: [] });
	});

	test('falls back from a missing FFPROBE_PATH to PATH', async () => {
		vi.stubEnv('FFPROBE_PATH', join(dir, 'missing'));
		await executable();
		await configure();
		await expect(ffprobe(input)).resolves.toMatchObject({ streams: [] });
	});

	test('prefers PATH over the FFMPEG_PATH sibling', async () => {
		await executable();
		const sibling = await executable(join(dir, 'custom', 'ffprobe'));
		await chmod(sibling, 0o644);
		vi.stubEnv('FFMPEG_PATH', join(dir, 'custom', 'ffmpeg'));
		await configure();
		await expect(ffprobe(input)).resolves.toMatchObject({ streams: [] });
	});

	test('falls back to the FFMPEG_PATH sibling', async () => {
		vi.stubEnv('FFPROBE_PATH', join(dir, 'missing'));
		await executable(join(dir, 'custom', 'ffprobe'));
		vi.stubEnv('FFMPEG_PATH', join(dir, 'custom', 'ffmpeg'));
		await configure();
		await expect(ffprobe(input)).resolves.toMatchObject({ streams: [] });
	});

	test('uses a changed FFPROBE_PATH on the next call without caching', async () => {
		vi.stubEnv('FFPROBE_PATH', await executable(join(dir, 'first')));
		await configure();
		await expect(ffprobe(input)).resolves.toMatchObject({ streams: [] });
		const inaccessible = await executable(join(dir, 'second'));
		await chmod(inaccessible, 0o644);
		vi.stubEnv('FFPROBE_PATH', inaccessible);
		await expect(ffprobe(input)).rejects.toMatchObject({ code: 'EACCES' });
	});

	test('does not fall back from a missing explicit binary', async () => {
		await executable();
		await configure();
		await expect(ffprobe(input, { binary: join(dir, 'missing') })).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('rejects when all executable candidates are missing', async () => {
		vi.stubEnv('FFPROBE_PATH', join(dir, 'missing'));
		vi.stubEnv('FFMPEG_PATH', join(dir, 'missing-dir', 'ffmpeg'));
		await configure();
		await expect(ffprobe(input)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test.each(['nonzero', 'malformed', 'hang'])('does not retry PATH when the configured binary reports %s', async (mode) => {
		vi.stubEnv('FFPROBE_PATH', await executable(join(dir, 'custom')));
		// A retry would replace the original error with EACCES.
		await writeFile(join(dir, 'ffprobe'), 'not executable');
		await configure(mode);
		const error = await ffprobe(input, { timeoutMs: 1000 }).catch((reason: unknown) => reason);
		if (mode === 'nonzero') expect(error).toMatchObject({ code: 1 });
		if (mode === 'malformed') expect(error).toBeInstanceOf(SyntaxError);
		if (mode === 'hang') expect(error).toMatchObject({ killed: true, signal: 'SIGKILL' });
		await expectExited();
	});
});
