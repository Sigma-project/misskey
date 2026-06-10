/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type JxlEncodeOptions = {
	quality: number;
	lossless: boolean;
	effort: number;
};

type EncodeFn = (data: ImageData, options?: Partial<JxlEncodeOptions>) => Promise<ArrayBuffer>;

let encodeModule: EncodeFn | null = null;
let encodePromise: Promise<EncodeFn> | null = null;

async function loadEncoder(): Promise<EncodeFn> {
	if (encodeModule != null) return encodeModule;
	if (encodePromise != null) return encodePromise;

	encodePromise = import('@jsquash/jxl')
		.then(({ encode }) => {
			encodeModule = encode;
			return encodeModule;
		})
		.finally(() => {
			encodePromise = null;
		});

	return encodePromise;
}

export function getImageDataFromCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): ImageData {
	const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
	if (ctx == null) {
		throw new Error('Failed to get 2d context from canvas');
	}
	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export async function encodeToJxl(imageData: ImageData, options: JxlEncodeOptions): Promise<Blob | null> {
	try {
		const encode = await loadEncoder();
		if (encode == null) return null;
		const arrayBuffer = await encode(imageData, options);
		return new Blob([arrayBuffer], { type: 'image/jxl' });
	} catch (err) {
		console.error('Failed to encode JXL via WASM', err);
		return null;
	}
}
