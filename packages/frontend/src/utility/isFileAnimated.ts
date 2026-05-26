/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import isAnimated from 'is-file-animated';

// ftyp ボックスが病的に大きい場合に備えたセーフティキャップ。
// 妥当な AVIF の ftyp はせいぜい数十〜数百バイト程度。
const FTYP_READ_CAP = 4096;

// ISOBMFF の ftyp ボックスを解析し、AVIF アニメーション用ブランド `avis` の有無で判定する。
// is-file-animated は GIF/PNG/WebP しか判定できないため、AVIF を別途扱う必要がある。
async function isAnimatedAvif(file: Blob): Promise<boolean> {
	if (file.size < 16) return false;

	// 先頭 16 バイトでヘッダー (size + type, 必要なら 64bit largesize) を確定する
	const headerBuffer = await file.slice(0, 16).arrayBuffer();
	const headerView = new DataView(headerBuffer);
	const headerBytes = new Uint8Array(headerBuffer);
	const decoder = new TextDecoder('ascii');

	if (decoder.decode(headerBytes.subarray(4, 8)) !== 'ftyp') return false;

	const sizeField = headerView.getUint32(0);
	let boxSize: number;
	let majorBrandOffset: number;
	let brandsStart: number;
	if (sizeField === 1) {
		// 64bit largesize が offset 8〜16 に入り、major_brand/minor_version/compatible_brands は 16 以降
		const high = headerView.getUint32(8);
		const low = headerView.getUint32(12);
		boxSize = high * 0x100000000 + low;
		majorBrandOffset = 16;
		brandsStart = 24;
	} else {
		// sizeField === 0 はボックスがファイル末尾まで続くことを意味する
		boxSize = sizeField === 0 ? file.size : sizeField;
		majorBrandOffset = 8;
		brandsStart = 16;
	}

	const readSize = Math.min(boxSize, file.size, FTYP_READ_CAP);
	if (readSize < majorBrandOffset + 4) return false;

	const buffer = readSize <= headerBuffer.byteLength
		? headerBuffer
		: await file.slice(0, readSize).arrayBuffer();
	const bytes = new Uint8Array(buffer);

	if (decoder.decode(bytes.subarray(majorBrandOffset, majorBrandOffset + 4)) === 'avis') return true;

	for (let offset = brandsStart; offset + 4 <= readSize; offset += 4) {
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
