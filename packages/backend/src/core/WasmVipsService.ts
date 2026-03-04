/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type Vips from 'wasm-vips';
import type { IImage } from '@/core/ImageProcessingService.js';
import { bindThis } from '@/decorators.js';

@Injectable()
export class WasmVipsService {
	private vipsPromise: Promise<typeof Vips> | null = null;

	@bindThis
	private getVips(): Promise<typeof Vips> {
		if (this.vipsPromise == null) {
			this.vipsPromise = import('wasm-vips').then(module => module.default());
		}
		return this.vipsPromise;
	}

	@bindThis
	public async convertAnimatedToJxl(
		inputBuffer: Buffer,
		width: number,
		height: number,
		options?: { quality?: number; lossless?: boolean; effort?: number; distance?: number },
	): Promise<IImage> {
		const vips = await this.getVips();

		// thumbnailBuffer で全フレーム読み込み＋リサイズ (option_string に n=-1 を指定)
		const img = vips.Image.thumbnailBuffer(inputBuffer, width, {
			option_string: 'n=-1',
			height: height,
			size: 'down',
		});

		try {
			const writeOptions: Record<string, unknown> = {};
			if (options?.quality != null) writeOptions.Q = options.quality;
			if (options?.lossless != null) writeOptions.lossless = options.lossless;
			if (options?.effort != null) writeOptions.effort = options.effort;
			if (options?.distance != null) writeOptions.distance = options.distance;

			const data = img.writeToBuffer('.jxl', writeOptions);

			return {
				data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
				ext: 'jxl',
				type: 'image/jxl',
			};
		} finally {
			img.delete();
		}
	}
}
