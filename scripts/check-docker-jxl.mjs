/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/backend/package.json', import.meta.url));
const sharp = require('sharp');
const width = 17;
const height = 11;
const pixels = Buffer.alloc(width * height * 3);
for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) % 256;
const input = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
const jxl = await sharp(input).jxl({ lossless: true, effort: 1 }).toBuffer();
assert.equal((await sharp(jxl).metadata()).format, 'jxl');
const png = await sharp(jxl).png().toBuffer();
assert.equal((await sharp(png).metadata()).format, 'png');
const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true });
assert.equal(decoded.info.width, width);
assert.equal(decoded.info.height, height);
assert.equal(decoded.info.channels, 3);
assert.deepEqual(decoded.data, pixels);
for (const format of ['jpeg', 'webp', 'png']) {
	const encoded = await sharp(input).toFormat(format).toBuffer();
	const metadata = await sharp(encoded).metadata();
	assert.equal(metadata.format, format);
	assert.equal(metadata.width, width);
	assert.equal(metadata.height, height);
	await sharp(encoded).raw().toBuffer();
}
console.log(`JXL round trip passed (${process.arch}, libvips ${sharp.versions.vips}, sharp ${sharp.versions.sharp})`);
