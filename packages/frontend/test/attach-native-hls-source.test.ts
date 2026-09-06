/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { attachNativeHlsSource } from '@/utility/attach-native-hls-source.js';

describe('native HLS codec fallback', () => {
	test('falls back to the original once when a manifest cannot be decoded', () => {
		const el = document.createElement('video');
		const cleanup = attachNativeHlsSource(el, 'https://example.com/master.m3u8', 'https://example.com/original.mp4');
		expect(el.src).toBe('https://example.com/master.m3u8');
		el.dispatchEvent(new Event('error'));
		expect(el.src).toBe('https://example.com/original.mp4');
		el.src = 'https://example.com/next.mp4';
		el.dispatchEvent(new Event('error'));
		expect(el.src).toBe('https://example.com/next.mp4');
		cleanup();
	});

	test('removes the error fallback when the video is deactivated or unmounted', () => {
		const el = document.createElement('video');
		const cleanup = attachNativeHlsSource(el, 'https://example.com/master.m3u8', 'https://example.com/original.mp4');
		cleanup();
		el.src = 'https://example.com/next.mp4';
		el.dispatchEvent(new Event('error'));
		expect(el.src).toBe('https://example.com/next.mp4');
	});
});
