/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import isAnimated from 'is-file-animated';

// ISOBMFF の ftyp ボックスを読み、AVIF アニメーション用ブランド `avis` の有無で判定する。
// is-file-animated は GIF/PNG/WebP しか判定できないため、AVIF を別途扱う必要がある。
async function isAnimatedAvif(file: Blob): Promise<boolean> {
	const headerSize = Math.min(file.size, 64);
	if (headerSize < 16) return false;

	const buffer = await file.slice(0, headerSize).arrayBuffer();
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const decoder = new TextDecoder('ascii');

	if (decoder.decode(bytes.subarray(4, 8)) !== 'ftyp') return false;

	const boxSize = view.getUint32(0);
	const brandsEnd = Math.min(boxSize === 0 ? buffer.byteLength : boxSize, buffer.byteLength);

	if (decoder.decode(bytes.subarray(8, 12)) === 'avis') return true;

	for (let offset = 16; offset + 4 <= brandsEnd; offset += 4) {
		if (decoder.decode(bytes.subarray(offset, offset + 4)) === 'avis') return true;
	}
	return false;
}

export async function isFileAnimated(file: Blob): Promise<boolean> {
	if (file.type === 'image/avif') {
		return isAnimatedAvif(file);
	}
	return isAnimated(file);
}
