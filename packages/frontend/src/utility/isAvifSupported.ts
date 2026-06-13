/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

let isAvifSupportedCache: boolean | undefined;
export function isAvifSupported() {
	if (isAvifSupportedCache === undefined) {
		const canvas = window.document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		isAvifSupportedCache = canvas.toDataURL('image/avif').startsWith('data:image/avif');
	}
	return isAvifSupportedCache;
}
