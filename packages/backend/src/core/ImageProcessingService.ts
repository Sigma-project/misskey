/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import type { Sharp, AvifOptions, JxlOptions } from 'sharp';

export type IImage = {
	data: Buffer;
	ext: string | null;
	type: string;
};

export type IImageStream = {
	data: Readable;
	ext: string | null;
	type: string;
};

export type IImageSharp = {
	data: Sharp;
	ext: string | null;
	type: string;
};

export type IImageStreamable = IImage | IImageStream | IImageSharp;

export const avifDefault: AvifOptions = {
	quality: 60,
	lossless: false,
	effort: 2,
};

export const jxlDefault: JxlOptions = {
	quality: 100,
	lossless: true,
	effort: 9,
	distance: 0,
};

import { bindThis } from '@/decorators.js';
import { Readable } from 'node:stream';

@Injectable()
export class ImageProcessingService {
	constructor(
	) {
	}

	/**
	 * Convert to Avif
	 *   with resize, remove metadata, resolve orientation, stop animation
	 */
	@bindThis
	public async convertToAvif(path: string, width: number, height: number, options: AvifOptions = avifDefault): Promise<IImage> {
		return this.convertSharpToAvif(sharp(path), width, height, options);
	}

	@bindThis
	public async convertSharpToAvif(sharp: Sharp, width: number, height: number, options: AvifOptions = avifDefault): Promise<IImage> {
		const result = this.convertSharpToAvifStream(sharp, width, height, options);

		return {
			data: await result.data.toBuffer(),
			ext: result.ext,
			type: result.type,
		};
	}

	@bindThis
	public convertToAvifStream(path: string, width: number, height: number, options: AvifOptions = avifDefault): IImageSharp {
		return this.convertSharpToAvifStream(sharp(path), width, height, options);
	}

	@bindThis
	public convertSharpToAvifStream(sharp: Sharp, width: number, height: number, options: AvifOptions = avifDefault): IImageSharp {
		const data = sharp
			.resize(width, height, {
				fit: 'inside',
				withoutEnlargement: true,
			})
			.rotate()
			.avif(options);

		return {
			data,
			ext: 'avif',
			type: 'image/avif',
		};
	}

	/**
	 * Convert to JPEG XL
	 *   with resize, remove metadata, resolve orientation, stop animation
	 */
	@bindThis
	public async convertToJxl(path: string, width: number, height: number, options: JxlOptions = jxlDefault): Promise<IImage> {
		return this.convertSharpToJxl(sharp(path), width, height, options);
	}

	@bindThis
	public async convertSharpToJxl(sharp: Sharp, width: number, height: number, options: JxlOptions = jxlDefault): Promise<IImage> {
		const result = this.convertSharpToJxlStream(sharp, width, height, options);

		return {
			data: await result.data.toBuffer(),
			ext: result.ext,
			type: result.type,
		};
	}

	@bindThis
	public convertToJxlStream(path: string, width: number, height: number, options: JxlOptions = jxlDefault): IImageSharp {
		return this.convertSharpToJxlStream(sharp(path), width, height, options);
	}

	@bindThis
	public convertSharpToJxlStream(sharp: Sharp, width: number, height: number, options: JxlOptions = jxlDefault): IImageSharp {
		const data = sharp
			.resize(width, height, {
				fit: 'inside',
				withoutEnlargement: true,
			})
			.rotate()
			.jxl(options);

		return {
			data,
			ext: 'jxl',
			type: 'image/jxl',
		};
	}
}
