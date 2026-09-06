/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import FFmpeg from 'fluent-ffmpeg';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import type { OnApplicationBootstrap } from '@nestjs/common';

export type FFmpegCapabilities = {
	/** AV1 encoder (libsvtav1) */
	av1: boolean;
	/** VVC/H.266 encoder (libvvenc) */
	vvc: boolean;
	/** Opus audio encoder (libopus) */
	opus: boolean;
	/** HLS muxer (fMP4 segments) */
	hls: boolean;
	/** DASH muxer */
	dash: boolean;
};

const ALL_DISABLED: FFmpegCapabilities = {
	av1: false,
	vvc: false,
	opus: false,
	hls: false,
	dash: false,
};

@Injectable()
export class FFmpegCapabilityService implements OnApplicationBootstrap {
	private logger: Logger;
	private cached: FFmpegCapabilities | null = null;
	private detecting: Promise<FFmpegCapabilities> | null = null;

	constructor(
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('ffmpeg-capability');
	}

	/**
	 * 起動時にバックグラウンドで検出を走らせてログ出力する（起動はブロックしない）。
	 */
	@bindThis
	public onApplicationBootstrap(): void {
		this.getCapabilities().catch(() => { /* getCapabilities内でログ済み */ });
	}

	/**
	 * エンコーダ/muxerの対応状況を返す（初回のみ検出し、以降はキャッシュ）。
	 */
	@bindThis
	public async getCapabilities(): Promise<FFmpegCapabilities> {
		if (this.cached) return this.cached;
		if (!this.detecting) {
			this.detecting = this.detect();
		}
		try {
			this.cached = await this.detecting;
			return this.cached;
		} catch (err) {
			// 検出失敗時は次回再試行できるようリセットし、安全側（全無効）を返す
			this.detecting = null;
			this.logger.error('Failed to detect ffmpeg capabilities. Treating all codecs as unavailable.', err as Error);
			return ALL_DISABLED;
		}
	}

	@bindThis
	private async detect(): Promise<FFmpegCapabilities> {
		const [encoders, formats] = await Promise.all([
			this.getAvailableEncoders(),
			this.getAvailableFormats(),
		]);

		const hasEncoder = (name: string) => Object.prototype.hasOwnProperty.call(encoders, name);
		const hasMuxer = (name: string) => Object.prototype.hasOwnProperty.call(formats, name) && formats[name].canMux;

		const caps: FFmpegCapabilities = {
			av1: hasEncoder('libsvtav1'),
			vvc: hasEncoder('libvvenc'),
			opus: hasEncoder('libopus'),
			hls: hasMuxer('hls'),
			dash: hasMuxer('dash'),
		};

		this.logger.info(`AV1 encoder (libsvtav1): ${caps.av1 ? 'available' : 'not available'}`);
		this.logger.info(`VVC encoder (libvvenc): ${caps.vvc ? 'available' : 'not available'}`);
		this.logger.info(`Opus encoder (libopus): ${caps.opus ? 'available' : 'not available'}`);
		this.logger.info(`HLS fMP4 muxer: ${caps.hls ? 'available' : 'not available'}`);
		this.logger.info(`DASH muxer: ${caps.dash ? 'available' : 'not available'}`);

		return caps;
	}

	@bindThis
	private getAvailableEncoders(): Promise<FFmpeg.Encoders> {
		return new Promise((resolve, reject) => {
			FFmpeg.getAvailableEncoders((err, encoders) => {
				if (err) reject(err);
				else resolve(encoders);
			});
		});
	}

	@bindThis
	private getAvailableFormats(): Promise<FFmpeg.Formats> {
		return new Promise((resolve, reject) => {
			FFmpeg.getAvailableFormats((err, formats) => {
				if (err) reject(err);
				else resolve(formats);
			});
		});
	}
}
