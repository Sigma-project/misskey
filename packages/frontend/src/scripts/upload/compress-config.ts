/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import isAnimated from 'is-file-animated';
// import { isWebpSupported } from './isWebpSupported.js';
import { isJxlSupported } from './isJxlSupported.js';
import type { BrowserImageResizerConfigWithConvertedOutput } from '@misskey-dev/browser-image-resizer';

const compressTypeMap = {
	'image/jpeg': { quality: 1, mimeType: 'image/jxl' },
	'image/png': { quality: 1, mimeType: 'image/jxl' },
	'image/webp': { quality: 1, mimeType: 'image/jxl' },
	'image/jxl': { quality: 1, mimeType: 'image/jxl' },
	'image/svg+xml': { quality: 1, mimeType: 'image/jxl' },
} as const;

const compressTypeMapFallback = {
	'image/jpeg': { quality: 1, mimeType: 'image/jpeg' },
	'image/png': { quality: 1, mimeType: 'image/png' },
	'image/webp': { quality: 1, mimeType: 'image/jpeg' },
	'image/jxl': { quality: 1, mimeType: 'image/jpeg' },
	'image/svg+xml': { quality: 1, mimeType: 'image/png' },
} as const;

export async function getCompressionConfig(file: File): Promise<BrowserImageResizerConfigWithConvertedOutput | undefined> {
	const imgConfig = (isJxlSupported() ? compressTypeMap : compressTypeMapFallback)[file.type];
	if (!imgConfig || await isAnimated(file)) {
		return;
	}

	return {
		maxWidth: 11648,
		maxHeight: 11648,
		debug: true,
		...imgConfig,
	};
}
