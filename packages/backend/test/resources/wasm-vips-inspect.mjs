/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Vips from 'wasm-vips';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const vips = await Vips();
const image = vips.Image.jxlloadBuffer(Buffer.concat(chunks), { n: -1 });
try {
	console.log(JSON.stringify({
		width: image.width,
		height: image.height,
		pages: image.getInt('n-pages'),
		pageHeight: image.getInt('page-height'),
	}));
} finally {
	image.delete();
}
process.exit(0);
