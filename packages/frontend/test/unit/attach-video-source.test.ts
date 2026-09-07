/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type Hls from 'hls.js';
import { attachVideoSource } from '@/utility/attach-video-source.js';

function video(nativeHls = false) {
	const el = document.createElement('video');
	vi.spyOn(el, 'canPlayType').mockReturnValue(nativeHls ? 'probably' : '');
	vi.spyOn(el, 'play').mockResolvedValue();
	vi.spyOn(el, 'pause').mockImplementation(() => {});
	vi.spyOn(el, 'load').mockImplementation(() => {});
	return el;
}

function mockHls(supported = true) {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const instance = {
		on: vi.fn((event: string, listener: (...args: unknown[]) => void) => handlers.set(event, listener)),
		loadSource: vi.fn(),
		attachMedia: vi.fn(),
		destroy: vi.fn(),
	};
	const ctor = Object.assign(vi.fn(function () { return instance; }), {
		isSupported: () => supported,
		Events: { ERROR: 'error', MANIFEST_PARSED: 'parsed' },
	});
	const module = { default: ctor as unknown as typeof Hls };
	return { instance, ctor, module, handlers };
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
}

describe('attachVideoSource', () => {
	test('plays the original without loading hls.js when no manifest exists', () => {
		const el = video();
		const loader = vi.fn();
		const dispose = attachVideoSource(el, 'https://example.com/original.mp4', null, loader);
		expect(el.src).toBe('https://example.com/original.mp4');
		expect(el.play).toHaveBeenCalledOnce();
		expect(loader).not.toHaveBeenCalled();
		dispose();
		expect(el.pause).toHaveBeenCalledOnce();
		expect(el.hasAttribute('src')).toBe(false);
	});

	test('uses native HLS and falls back on a media error', () => {
		const el = video(true);
		const loader = vi.fn();
		const dispose = attachVideoSource(el, 'https://example.com/original.mp4', 'https://example.com/master.m3u8', loader);
		expect(el.src).toBe('https://example.com/master.m3u8');
		expect(loader).not.toHaveBeenCalled();
		el.dispatchEvent(new Event('error'));
		expect(el.src).toBe('https://example.com/original.mp4');
		dispose();
	});

	test('attaches hls.js, starts on manifest parsing, and destroys on disposal', async () => {
		const el = video();
		const hls = mockHls();
		const dispose = attachVideoSource(el, 'https://example.com/original.mp4', 'https://example.com/master.m3u8', async () => hls.module);
		await flush();
		expect(hls.instance.loadSource).toHaveBeenCalledWith('https://example.com/master.m3u8');
		expect(hls.instance.attachMedia).toHaveBeenCalledWith(el);
		expect(el.play).not.toHaveBeenCalled();
		hls.handlers.get('parsed')!();
		expect(el.play).toHaveBeenCalledOnce();
		dispose();
		expect(hls.instance.destroy).toHaveBeenCalledOnce();
		expect(el.hasAttribute('src')).toBe(false);
		hls.handlers.get('parsed')!();
		expect(el.play).toHaveBeenCalledOnce();
	});

	test('falls back when hls.js is unsupported or fails to import', async () => {
		for (const load of [async () => mockHls(false).module, async () => { throw new Error('import failed'); }]) {
			const el = video();
			const dispose = attachVideoSource(el, 'https://example.com/original.mp4', 'https://example.com/master.m3u8', load);
			await flush();
			expect(el.src).toBe('https://example.com/original.mp4');
			dispose();
		}
	});

	test('destroys HLS and falls back only for fatal errors', async () => {
		const el = video();
		const hls = mockHls();
		const dispose = attachVideoSource(el, 'https://example.com/original.mp4', 'https://example.com/master.m3u8', async () => hls.module);
		await flush();
		hls.handlers.get('error')!('error', { fatal: false });
		expect(hls.instance.destroy).not.toHaveBeenCalled();
		hls.handlers.get('error')!('error', { fatal: true });
		expect(hls.instance.destroy).toHaveBeenCalledOnce();
		expect(el.src).toBe('https://example.com/original.mp4');
		dispose();
		expect(hls.instance.destroy).toHaveBeenCalledOnce();
	});

	test.each(['resolve', 'reject'] as const)('ignores a late import %s after switching away and back', async (result) => {
		const el = video();
		const hls = mockHls();
		let resolve!: (module: { default: typeof Hls }) => void;
		let reject!: (error: Error) => void;
		const pending = new Promise<{ default: typeof Hls }>((res, rej) => { resolve = res; reject = rej; });
		const oldDispose = attachVideoSource(el, 'https://example.com/old.mp4', 'https://example.com/old.m3u8', () => pending);
		oldDispose();
		const dispose = attachVideoSource(el, 'https://example.com/new.mp4', null);
		if (result === 'resolve') resolve(hls.module);
		else reject(new Error('late failure'));
		await flush();
		expect(hls.ctor).not.toHaveBeenCalled();
		expect(el.src).toBe('https://example.com/new.mp4');
		dispose();
	});
});
