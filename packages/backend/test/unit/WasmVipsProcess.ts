/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WasmVipsService } from '@/core/WasmVipsService.js';

vi.mock('node:child_process', async importOriginal => {
	const actual = await importOriginal<typeof import('node:child_process')>();
	return { ...actual, fork: vi.fn(actual.fork) };
});

let service: WasmVipsService;
let input: Buffer;
const options = { quality: 100, lossless: true, effort: 9, distance: 0 };

beforeEach(async () => {
	vi.useFakeTimers();
	input = await readFile(new URL('../resources/anime.gif', import.meta.url));
	service = new WasmVipsService();
});

afterEach(async () => {
	vi.useRealTimers();
	await service.onApplicationShutdown();
});

function inspect(data: Buffer): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = execFile(process.execPath, [fileURLToPath(new URL('../resources/wasm-vips-inspect.mjs', import.meta.url))], (error, stdout) => {
			if (error) reject(error);
			else {
				try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
			}
		});
		child.stdin!.on('error', reject).end(data);
	});
}

describe('wasm-vips real processes', () => {
	test('preserves all frames, resize options and a sliced input buffer across IPC', async () => {
		const backing = Buffer.alloc(input.length + 100, 42);
		input.copy(backing, 50);
		const view = backing.subarray(50, 50 + input.length);
		const original = Buffer.from(backing);
		const result = await service.convertAnimatedToJxl(view, 64, 64, options);
		expect(backing).toEqual(original);
		expect(result).toMatchObject({ ext: 'jxl', type: 'image/jxl' });
		expect(Buffer.isBuffer(result.data)).toBe(true);
		expect(await inspect(result.data)).toEqual({ width: 64, height: 128, pages: 2, pageHeight: 64 });
	});

	test('returns conversion errors and reuses the process for the next valid input', async () => {
		await expect(service.convertAnimatedToJxl(Buffer.from('invalid'), 64, 64, options)).rejects.toThrow();
		const child = vi.mocked(fork).mock.results.at(-1)!.value;
		const result = await service.convertAnimatedToJxl(input, 64, 64, options);
		expect(vi.mocked(fork).mock.results.at(-1)!.value).toBe(child);
		expect(result.data.length).toBeGreaterThan(0);
	});

	test('releases the process and its pthreads after idle, and can repeat this without retaining old processes', async () => {
		for (let cycle = 0; cycle < 3; cycle++) {
			const result = await service.convertAnimatedToJxl(input, 64, 64, options);
			const saved = Buffer.from(result.data);
			const child = vi.mocked(fork).mock.results.at(-1)!.value;
			const pid = child.pid!;
			if (process.platform === 'linux') {
				const tids = await readdir('/proc/' + pid + '/task');
				const names = await Promise.all(tids.map(tid => readFile('/proc/' + pid + '/task/' + tid + '/comm', 'utf8').catch(() => '')));
				expect(names.filter(name => name.trim() === 'em-pthread').length).toBeGreaterThan(0);
			}
			const closed = once(child, 'exit');
			await vi.advanceTimersByTimeAsync(30_000);
			await closed;
			expect(() => process.kill(pid, 0)).toThrow();
			expect(result.data).toEqual(saved);
		}
	});

	test('runs the worker asset emitted by the production build', async () => {
		const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
		vi.mocked(fork).mockImplementationOnce((_path, args, forkOptions) => actual.fork(
			new URL('../../built/workers/wasm-vips.mjs', import.meta.url), args as string[], forkOptions,
		));
		const result = await service.convertAnimatedToJxl(input, 64, 64, options);
		expect(await inspect(result.data)).toEqual({ width: 64, height: 128, pages: 2, pageHeight: 64 });
	});
});
