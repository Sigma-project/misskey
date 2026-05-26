/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import isAnimated from 'is-file-animated';

// ftyp ボックスが病的に大きい場合に備えたセーフティキャップ。
// 妥当な AVIF の ftyp はせいぜい数十バイト〜数百バイト程度。
const FTYP_READ_CAP = 4096;

// ISOBMFF の ftyp ボックス全体を読み、AVIF アニメーション用ブランド `avis` の有無で判定する。
// is-file-animated は GIF/PNG/WebP しか判定できないため、AVIF を別途扱う必要がある。
async function isAnimatedAvif(file: Blob): Promise<boolean> {
	if (file.size < 16) return false;

	const headerBuffer = await file.slice(0, 8).arrayBuffer();
	const headerView = new DataView(headerBuffer);
	const decoder = new TextDecoder('ascii');

	if (decoder.decode(new Uint8Array(headerBuffer, 4, 4)) !== 'ftyp') return false;

	let boxSize = headerView.getUint32(0);
	// boxSize === 0: ボックスがファイル末尾まで続く / boxSize === 1: 直後に 64bit largesize（ftyp ではまず存在しない）
	if (boxSize === 0 || boxSize === 1) boxSize = file.size;
	const readSize = Math.min(boxSize, file.size, FTYP_READ_CAP);
	if (readSize < 12) return false;

	const buffer = await file.slice(0, readSize).arrayBuffer();
	const bytes = new Uint8Array(buffer);

	if (decoder.decode(bytes.subarray(8, 12)) === 'avis') return true;

	for (let offset = 16; offset + 4 <= readSize; offset += 4) {
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
