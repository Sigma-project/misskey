/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { assert, describe, test } from 'vitest';
import { isFileAnimated } from '@/utility/isFileAnimated.js';

type MakeFtypArgs = {
	majorBrand: string;
	compatibleBrands: string[];
	useLargeSize?: boolean;
};

function makeAvifFtypBlob({ majorBrand, compatibleBrands, useLargeSize }: MakeFtypArgs): Blob {
	const enc = new TextEncoder();
	const brandsBytes = compatibleBrands.length * 4;
	if (useLargeSize) {
		const totalSize = 8 + 8 + 4 + 4 + brandsBytes;
		const buffer = new ArrayBuffer(totalSize);
		const view = new DataView(buffer);
		const bytes = new Uint8Array(buffer);
		view.setUint32(0, 1);
		bytes.set(enc.encode('ftyp'), 4);
		view.setUint32(8, 0);
		view.setUint32(12, totalSize);
		bytes.set(enc.encode(majorBrand), 16);
		view.setUint32(20, 0);
		for (let i = 0; i < compatibleBrands.length; i++) {
			bytes.set(enc.encode(compatibleBrands[i]), 24 + i * 4);
		}
		return new Blob([buffer], { type: 'image/avif' });
	} else {
		const totalSize = 8 + 4 + 4 + brandsBytes;
		const buffer = new ArrayBuffer(totalSize);
		const view = new DataView(buffer);
		const bytes = new Uint8Array(buffer);
		view.setUint32(0, totalSize);
		bytes.set(enc.encode('ftyp'), 4);
		bytes.set(enc.encode(majorBrand), 8);
		view.setUint32(12, 0);
		for (let i = 0; i < compatibleBrands.length; i++) {
			bytes.set(enc.encode(compatibleBrands[i]), 16 + i * 4);
		}
		return new Blob([buffer], { type: 'image/avif' });
	}
}

describe('isFileAnimated (AVIF)', () => {
	test('major_brand が avis のとき true', async () => {
		const blob = makeAvifFtypBlob({ majorBrand: 'avis', compatibleBrands: ['avif', 'mif1'] });
		assert.isTrue(await isFileAnimated(blob));
	});

	test('compatible_brands に avis を含むとき true', async () => {
		const blob = makeAvifFtypBlob({ majorBrand: 'avif', compatibleBrands: ['avif', 'avis', 'mif1'] });
		assert.isTrue(await isFileAnimated(blob));
	});

	test('avis を含まない静止 AVIF は false', async () => {
		const blob = makeAvifFtypBlob({ majorBrand: 'avif', compatibleBrands: ['avif', 'mif1', 'miaf', 'MA1B'] });
		assert.isFalse(await isFileAnimated(blob));
	});

	test('ftyp が 64 バイトを超えても compatible_brands 末尾の avis を検出する', async () => {
		// 16 brands × 4byte = 64byte → ボックス全体 80byte
		const compatibleBrands = [
			'avif', 'mif1', 'miaf', 'MA1B',
			'heic', 'heix', 'mp41', 'mp42',
			'isom', 'iso2', 'iso4', 'msf1',
			'pict', 'jpeg', 'png ', 'avis',
		];
		const blob = makeAvifFtypBlob({ majorBrand: 'avif', compatibleBrands });
		assert.isAbove(blob.size, 64);
		assert.isTrue(await isFileAnimated(blob));
	});

	test('64bit largesize 経由で avis を検出できる', async () => {
		const blob = makeAvifFtypBlob({ majorBrand: 'avif', compatibleBrands: ['avif', 'avis'], useLargeSize: true });
		assert.isTrue(await isFileAnimated(blob));
	});

	test('ftyp 以外のヘッダーは false', async () => {
		const buffer = new ArrayBuffer(32);
		const view = new DataView(buffer);
		view.setUint32(0, 32);
		new Uint8Array(buffer).set(new TextEncoder().encode('moov'), 4);
		const blob = new Blob([buffer], { type: 'image/avif' });
		assert.isFalse(await isFileAnimated(blob));
	});

	test('16 バイト未満のファイルは false', async () => {
		const blob = new Blob([new Uint8Array(8)], { type: 'image/avif' });
		assert.isFalse(await isFileAnimated(blob));
	});
});
