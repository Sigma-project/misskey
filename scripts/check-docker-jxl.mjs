/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/backend/package.json', import.meta.url));
const sharp = require('sharp');
const buildScript = readFileSync(new URL('./docker-build-libvips.sh', import.meta.url), 'utf8');
assert.equal(sharp.versions.vips, /^vips_version=(.+)$/m.exec(buildScript)?.[1]);
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
for (const format of ['jpeg', 'webp', 'png', 'tiff']) {
	const encoded = await sharp(input).toFormat(format).toBuffer();
	const metadata = await sharp(encoded).metadata();
	assert.equal(metadata.format, format);
	assert.equal(metadata.width, width);
	assert.equal(metadata.height, height);
	await sharp(encoded).raw().toBuffer();
}
// libheif's decoders are dynamically loaded: ldd alone cannot prove they work.
for (const fixture of ['with-alpha.avif', 'without-alpha.avif', 'image.svg']) {
	const file = new URL(`../packages/backend/test/resources/${fixture}`, import.meta.url);
	const output = await sharp(readFileSync(file)).jxl({ effort: 1 }).toBuffer();
	assert.equal((await sharp(output).metadata()).format, 'jxl');
}

// Animated JXL uses WASM, whose runtime assets must survive the Docker build.
const { default: createVips } = await import(require.resolve('wasm-vips'));
const vips = await createVips();
const animation = vips.Image.thumbnailBuffer(
	readFileSync(new URL('../packages/backend/test/resources/anime.gif', import.meta.url)),
	32, { option_string: 'n=-1', height: 32, size: 'down' },
);
try {
	const animatedJxl = animation.writeToBuffer('.jxl', { effort: 1, lossless: true });
	const decodedAnimation = vips.Image.newFromBuffer(animatedJxl, 'n=-1');
	try {
		assert.equal(decodedAnimation.getInt('n-pages'), animation.getInt('n-pages'));
		assert.ok(decodedAnimation.getInt('n-pages') > 1);
		assert.equal(decodedAnimation.width, animation.width);
		assert.equal(decodedAnimation.height, animation.height);
	} finally {
		decodedAnimation.delete();
	}
} finally {
	animation.delete();
	vips.shutdown();
}
console.log(`JXL round trip passed (${process.arch}, libvips ${sharp.versions.vips}, sharp ${sharp.versions.sharp})`);
