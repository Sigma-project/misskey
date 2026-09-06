/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as Path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import FFmpeg from 'fluent-ffmpeg';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { LoggerService } from '@/core/LoggerService.js';
import { FFmpegCapabilityService } from '@/core/FFmpegCapabilityService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

export type TranscodingCodec = 'av1' | 'vvc';

export type TranscodingVariant = {
	codec: TranscodingCodec;
	container: 'cmaf';
	manifestType: 'hls' | 'dash' | 'both';
	/** prefix からの相対パス（例: 'av1/playlist.m3u8'） */
	playlistPath: string;
	initPath: string;
	width: number;
	height: number;
	/** bps */
	bitrate: number;
	durationSec: number;
	byteSize: number;
	codecString: string;
};

export type TranscodeProgress = {
	codec: TranscodingCodec;
	phase: 'encoding-av1' | 'encoding-vvc';
	percent: number;
	fps?: number;
	speed?: string;
};

export type TranscodeResult = {
	variants: TranscodingVariant[];
	hasHls: boolean;
	hasDash: boolean;
};

// キャンセル要求で中断したことを示すエラー（呼び出し側がリトライせず中断扱いにするための目印）
export class TranscodeCancelledError extends Error {
	public readonly isTranscodeCancelled = true;
	constructor() {
		super('Transcoding was cancelled');
		this.name = 'TranscodeCancelledError';
	}
}

const SEGMENT_SECONDS = 6;
// 協調キャンセルの確認間隔（DB問い合わせを伴うため間引く）
const CANCEL_CHECK_INTERVAL_MS = 3000;
// 暴走・ストレージ枯渇対策のデフォルト出力サイズ上限（呼び出し側で上書き可）
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
// ffmpeg の wall-clock タイムアウト（動画長 × 係数 + 余裕、ただし上限あり）
const TIMEOUT_FACTOR = 30;
const TIMEOUT_BASE_MS = 60 * 1000;
const TIMEOUT_MAX_MS = 6 * 60 * 60 * 1000; // 6h

@Injectable()
export class VideoTranscodingService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		private ffmpegCapabilityService: FFmpegCapabilityService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('video-transcoding');
	}

	/**
	 * 入力動画を AV1(HLS) と VVC(DASH) にトランスコードし、CMAF セグメントと
	 * HLS master / DASH manifest を outDir 配下に生成する。
	 * outDir のライフサイクル（作成・削除）は呼び出し側が管理する。
	 */
	@bindThis
	public async transcode(opts: {
		inputPath: string;
		outDir: string;
		durationSec: number;
		sourceVideoCodec?: string;
		maxOutputBytes?: number;
		shouldCancel?: () => Promise<boolean>;
		onProgress?: (p: TranscodeProgress) => void;
	}): Promise<TranscodeResult> {
		const caps = await this.ffmpegCapabilityService.getCapabilities();
		if (!caps.av1 || !caps.hls) {
			// AV1/HLS が無い環境では処理対象外（呼び出し側で skip 判定済みのはずだが二重防御）
			throw new Error('AV1 encoder or HLS muxer is not available');
		}

		const audioCodec: 'libopus' | 'aac' = caps.opus ? 'libopus' : 'aac';
		const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

		const variants: TranscodingVariant[] = [];

		// --- AV1 (HLS + DASH) ---
		await this.runHlsEncode({
			codec: 'av1',
			inputPath: opts.inputPath,
			outDir: opts.outDir,
			durationSec: opts.durationSec,
			audioCodec,
			copyVideo: opts.sourceVideoCodec === 'av1',
			maxOutputBytes,
			shouldCancel: opts.shouldCancel,
			onProgress: opts.onProgress,
		});
		const av1Variant = await this.collectVariant('av1', opts.outDir, opts.durationSec, audioCodec);
		if (av1Variant == null) {
			throw new Error('AV1 transcode produced no usable output');
		}
		variants.push(av1Variant);

		// AV1 完了時点でキャンセル確認（VVC に入る前に中断できるように）
		if (opts.shouldCancel != null && await opts.shouldCancel()) {
			throw new TranscodeCancelledError();
		}

		// --- VVC (DASH only) ---
		// encoder と DASH(あるいはfMP4 muxer) が揃う場合のみ。揃わなければ gate して AV1 のみで完結。
		if (caps.vvc) {
			try {
				await this.runHlsEncode({
					codec: 'vvc',
					inputPath: opts.inputPath,
					outDir: opts.outDir,
					durationSec: opts.durationSec,
					audioCodec,
					copyVideo: false,
					maxOutputBytes,
					shouldCancel: opts.shouldCancel,
					onProgress: opts.onProgress,
				});
				const vvcVariant = await this.collectVariant('vvc', opts.outDir, opts.durationSec, audioCodec);
				if (vvcVariant != null) {
					variants.push(vvcVariant);
				}
			} catch (err) {
				// キャンセルは中断として伝播させる（best-effort 扱いにしない）
				if (err instanceof TranscodeCancelledError) throw err;
				// VVC は best-effort。失敗しても AV1 の結果は活かす
				this.logger.warn('VVC transcode failed; continuing with AV1 only', err as Error);
			}
		}

		// 出力サイズ上限チェック
		const totalSize = await this.dirSize(opts.outDir);
		if (totalSize > maxOutputBytes) {
			throw new Error(`Transcoded output exceeds the size limit (${totalSize} > ${maxOutputBytes})`);
		}

		// HLS は AV1 のみ。manifestType を確定
		const av1 = variants.find(v => v.codec === 'av1')!;
		av1.manifestType = 'both';

		// master.m3u8（AV1 のみ）
		await fs.promises.writeFile(Path.join(opts.outDir, 'master.m3u8'), this.buildHlsMaster(av1));

		// manifest.mpd（AV1 + VVC、parse 済みメタ + 実セグメントから生成）
		let hasDash = false;
		try {
			const mpd = await this.buildDashManifest(variants, opts.outDir);
			await fs.promises.writeFile(Path.join(opts.outDir, 'manifest.mpd'), mpd);
			hasDash = true;
		} catch (err) {
			this.logger.warn('Failed to build DASH manifest; serving HLS only', err as Error);
		}

		return {
			variants,
			hasHls: true,
			hasDash,
		};
	}

	/**
	 * 1 コーデック分を HLS fMP4(CMAF) として {outDir}/{codec}/ に出力する。
	 */
	@bindThis
	private async runHlsEncode(opts: {
		codec: TranscodingCodec;
		inputPath: string;
		outDir: string;
		durationSec: number;
		audioCodec: 'libopus' | 'aac';
		copyVideo: boolean;
		maxOutputBytes?: number;
		shouldCancel?: () => Promise<boolean>;
		onProgress?: (p: TranscodeProgress) => void;
	}): Promise<void> {
		const codecDir = Path.join(opts.outDir, opts.codec);
		await fs.promises.mkdir(codecDir, { recursive: true });

		const playlistPath = Path.join(codecDir, 'playlist.m3u8');

		const videoOptions = opts.copyVideo
			? ['-c:v', 'copy']
			: opts.codec === 'av1'
				? ['-c:v', 'libsvtav1', '-preset', '8', '-crf', '32', '-pix_fmt', 'yuv420p', '-g', '120']
				: ['-c:v', 'libvvenc', '-preset', 'medium', '-qp', '32', '-pix_fmt', 'yuv420p', '-g', '120'];

		const audioOptions = ['-c:a', opts.audioCodec, '-b:a', '128k'];

		const hlsOptions = [
			'-f', 'hls',
			'-hls_time', String(SEGMENT_SECONDS),
			'-hls_playlist_type', 'vod',
			'-hls_segment_type', 'fmp4',
			'-hls_fmp4_init_filename', 'init.mp4',
			'-hls_segment_filename', Path.join(codecDir, 'seg-%03d.m4s'),
			// セグメント番号を1始まり(seg-001.m4s)に揃え、DASH SegmentTemplate startNumber=1 と一致させる
			'-start_number', '1',
			'-hls_flags', 'independent_segments',
		];

		const phase = opts.codec === 'av1' ? 'encoding-av1' as const : 'encoding-vvc' as const;
		const timeoutMs = Math.min(TIMEOUT_MAX_MS, TIMEOUT_BASE_MS + opts.durationSec * 1000 * TIMEOUT_FACTOR);

		await new Promise<void>((resolve, reject) => {
			const command = FFmpeg(opts.inputPath)
				.outputOptions([...videoOptions, ...audioOptions, ...hlsOptions])
				.output(playlistPath);

			let timedOut = false;
			let exceededSize = false;
			let cancelled = false;
			let sizeCheckInProgress = false;
			let cancelCheckInProgress = false;
			let lastCancelCheck = 0;
			const timer = setTimeout(() => {
				timedOut = true;
				command.kill('SIGKILL');
			}, timeoutMs);

			command
				.on('progress', (progress) => {
					if (opts.onProgress != null) {
						const timemarkSec = this.parseTimemark(progress.timemark);
						const percent = opts.durationSec > 0
							? Math.max(0, Math.min(100, (timemarkSec / opts.durationSec) * 100))
							: (progress.percent ?? 0);
						opts.onProgress({
							codec: opts.codec,
							phase,
							percent,
							fps: progress.currentFps,
							speed: progress.currentKbps != null ? `${progress.currentKbps}kbps` : undefined,
						});
					}

					// 出力サイズ上限を encode 中に監視し、超過したら kill する（暴走/ストレージ枯渇対策）
					if (opts.maxOutputBytes != null && !sizeCheckInProgress && !exceededSize) {
						sizeCheckInProgress = true;
						this.dirSize(opts.outDir).then(size => {
							if (size > opts.maxOutputBytes!) {
								exceededSize = true;
								command.kill('SIGKILL');
							}
						}).catch(() => { /* ignore */ }).finally(() => {
							sizeCheckInProgress = false;
						});
					}

					// 協調キャンセル: 一定間隔でキャンセル要求を確認し、要求されていれば kill する
					if (opts.shouldCancel != null && !cancelCheckInProgress && !cancelled) {
						const now = Date.now();
						if (now - lastCancelCheck >= CANCEL_CHECK_INTERVAL_MS) {
							lastCancelCheck = now;
							cancelCheckInProgress = true;
							opts.shouldCancel().then(shouldStop => {
								if (shouldStop) {
									cancelled = true;
									command.kill('SIGKILL');
								}
							}).catch(() => { /* ignore */ }).finally(() => {
								cancelCheckInProgress = false;
							});
						}
					}
				})
				.on('end', () => {
					clearTimeout(timer);
					resolve();
				})
				.on('error', (err) => {
					clearTimeout(timer);
					if (cancelled) reject(new TranscodeCancelledError());
					else if (timedOut) reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
					else if (exceededSize) reject(new Error('Transcoded output exceeded the size limit during encoding'));
					else reject(err);
				})
				.run();
		});

		// メディアプレイリストのセグメント URI を basename に正規化する
		// （-hls_segment_filename に絶対パスを渡したため）
		await this.rewritePlaylistToBasenames(playlistPath);
	}

	/**
	 * playlist.m3u8 中のセグメント/初期化セグメント参照を basename に書き換える。
	 */
	@bindThis
	private async rewritePlaylistToBasenames(playlistPath: string): Promise<void> {
		const content = await fs.promises.readFile(playlistPath, 'utf8');
		const rewritten = content.split('\n').map(line => {
			if (line.startsWith('#EXT-X-MAP:')) {
				return line.replace(/URI="([^"]+)"/, (_, uri: string) => `URI="${Path.basename(uri)}"`);
			}
			if (line.length > 0 && !line.startsWith('#')) {
				return Path.basename(line.trim());
			}
			return line;
		}).join('\n');
		await fs.promises.writeFile(playlistPath, rewritten);
	}

	/**
	 * 出力済みの 1 コーデック分から variant 記述子を組み立てる。
	 * init / 先頭セグメントを ffprobe し、実セグメントから duration・サイズを得る。
	 */
	@bindThis
	private async collectVariant(codec: TranscodingCodec, outDir: string, durationSec: number, audioCodec: 'libopus' | 'aac'): Promise<TranscodingVariant | null> {
		const codecDir = Path.join(outDir, codec);
		const initPath = Path.join(codecDir, 'init.mp4');
		const playlistPath = Path.join(codecDir, 'playlist.m3u8');

		if (!fs.existsSync(initPath) || !fs.existsSync(playlistPath)) {
			return null;
		}

		const segments = await this.parsePlaylistSegments(playlistPath);
		if (segments.length === 0) {
			return null;
		}

		// サイズ合計（init + 全セグメント）
		let byteSize = (await fs.promises.stat(initPath)).size;
		for (const seg of segments) {
			try {
				byteSize += (await fs.promises.stat(Path.join(codecDir, seg.file))).size;
			} catch { /* ignore missing */ }
		}

		// 寸法・コーデックを probe（init + 先頭セグメントを連結 probe するのは難しいので init を probe）
		const probe = await this.probe(initPath).catch(() => null);
		const videoStream = probe?.streams.find(s => s.codec_type === 'video');
		const width = videoStream?.width ?? 0;
		const height = videoStream?.height ?? 0;

		const bitrate = durationSec > 0 ? Math.round((byteSize * 8) / durationSec) : 0;

		const codecString = this.buildCodecString(codec, audioCodec, videoStream);

		return {
			codec,
			container: 'cmaf',
			manifestType: codec === 'av1' ? 'both' : 'dash',
			playlistPath: `${codec}/playlist.m3u8`,
			initPath: `${codec}/init.mp4`,
			width,
			height,
			bitrate,
			durationSec,
			byteSize,
			codecString,
		};
	}

	/**
	 * RFC6381 風の codecs 文字列を組み立てる（best-effort）。
	 * 正確な codec string（av01.0.05M.08 等）の完全な導出は ffprobe だけでは難しいため、
	 * profile/level/bitdepth から妥当な近似値を構築する。VVC は近似のため DASH 専用に留める。
	 */
	@bindThis
	private buildCodecString(codec: TranscodingCodec, audioCodec: 'libopus' | 'aac', videoStream: FFmpeg.FfprobeStream | undefined): string {
		const audio = audioCodec === 'libopus' ? 'opus' : 'mp4a.40.2';
		if (codec === 'av1') {
			// av01.<profile>.<level><tier>.<bitdepth>
			const profile = 0;
			const level = '05M'; // 近似（level 3.1 main 相当）。再生側は概ね probe で補完する
			const bitDepth = '08';
			return `av01.${profile}.${level}.${bitDepth},${audio}`;
		}
		// VVC: 正確な vvc1 codec string の導出は困難なため近似
		return `vvc1,${audio}`;
	}

	/**
	 * playlist.m3u8 を解析し、(ファイル名, 長さ秒) のセグメント列を返す。
	 */
	@bindThis
	private async parsePlaylistSegments(playlistPath: string): Promise<{ file: string; duration: number }[]> {
		const content = await fs.promises.readFile(playlistPath, 'utf8');
		const lines = content.split('\n');
		const segments: { file: string; duration: number }[] = [];
		let pendingDuration = 0;
		for (const raw of lines) {
			const line = raw.trim();
			if (line.startsWith('#EXTINF:')) {
				const m = /#EXTINF:([0-9.]+)/.exec(line);
				pendingDuration = m ? parseFloat(m[1]) : 0;
			} else if (line.length > 0 && !line.startsWith('#')) {
				segments.push({ file: Path.basename(line), duration: pendingDuration });
				pendingDuration = 0;
			}
		}
		return segments;
	}

	@bindThis
	private probe(filePath: string): Promise<FFmpeg.FfprobeData> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error('ffprobe timed out'));
			}, 30 * 1000);
			FFmpeg.ffprobe(filePath, (err, metadata) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (err) reject(err);
				else resolve(metadata);
			});
		});
	}

	@bindThis
	private parseTimemark(timemark: string | undefined): number {
		if (!timemark) return 0;
		// HH:MM:SS.xx
		const parts = timemark.split(':');
		if (parts.length !== 3) return 0;
		const h = parseInt(parts[0], 10);
		const m = parseInt(parts[1], 10);
		const s = parseFloat(parts[2]);
		if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return 0;
		return h * 3600 + m * 60 + s;
	}

	@bindThis
	private async dirSize(dir: string): Promise<number> {
		let total = 0;
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = Path.join(dir, entry.name);
			if (entry.isDirectory()) {
				total += await this.dirSize(full);
			} else if (entry.isFile()) {
				total += (await fs.promises.stat(full)).size;
			}
		}
		return total;
	}

	/**
	 * HLS master playlist を生成する（AV1 variant のみ）。
	 * CODECS 属性は誤りのリスクを避けるため付けず、解像度・帯域のみ記載する
	 * （省略は HLS 仕様上許容され、プレイヤーがメディアから判定する）。
	 */
	@bindThis
	private buildHlsMaster(av1: TranscodingVariant): string {
		const lines = [
			'#EXTM3U',
			'#EXT-X-VERSION:7',
			`#EXT-X-STREAM-INF:BANDWIDTH=${av1.bitrate}${av1.width > 0 ? `,RESOLUTION=${av1.width}x${av1.height}` : ''}`,
			av1.playlistPath,
			'',
		];
		return lines.join('\n');
	}

	/**
	 * DASH manifest(.mpd) を SegmentTemplate + SegmentTimeline 形式で生成する。
	 * 各 representation の init / 実セグメント数 / 実セグメント長（playlist の #EXTINF）を用い、
	 * codecs/width/height/bandwidth は probe 済みメタから埋める（固定テンプレートにしない）。
	 *
	 * probe に失敗して width/height・codec を信頼できない representation は除外する
	 * （壊れた MPD を出すより安全。特に VVC は probe が取れない環境では gate される）。
	 */
	@bindThis
	private async buildDashManifest(variants: TranscodingVariant[], outDir: string): Promise<string> {
		const maxDuration = Math.max(...variants.map(v => v.durationSec), 0);
		const adaptationSets: string[] = [];

		for (const variant of variants) {
			// probe 失敗（width=0）は codec/寸法が信頼できないため representation を出さない
			if (variant.width <= 0 || variant.height <= 0) continue;

			const playlistPath = Path.join(outDir, variant.playlistPath);
			const segments = await this.parsePlaylistSegments(playlistPath);
			if (segments.length === 0) continue;

			// SegmentTimeline で各セグメントの実長(ms, timescale=1000)を反映する
			const timeline = segments
				.map(seg => `\t\t\t\t\t\t<S d="${Math.round(seg.duration * 1000)}"/>`)
				.join('\n');

			adaptationSets.push([
				`\t\t<AdaptationSet contentType="video" segmentAlignment="true" mimeType="video/mp4">`,
				`\t\t\t<Representation id="${variant.codec}" codecs="${variant.codecString}" width="${variant.width}" height="${variant.height}" bandwidth="${variant.bitrate}">`,
				`\t\t\t\t<SegmentTemplate timescale="1000" initialization="${variant.codec}/init.mp4" media="${variant.codec}/seg-$Number%03d$.m4s" startNumber="1">`,
				`\t\t\t\t\t<SegmentTimeline>`,
				timeline,
				`\t\t\t\t\t</SegmentTimeline>`,
				`\t\t\t\t</SegmentTemplate>`,
				`\t\t\t</Representation>`,
				`\t\t</AdaptationSet>`,
			].join('\n'));
		}

		if (adaptationSets.length === 0) {
			throw new Error('No usable representation for DASH manifest');
		}

		return [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static"',
			`\tmediaPresentationDuration="PT${maxDuration.toFixed(3)}S" minBufferTime="PT2S">`,
			'\t<Period>',
			adaptationSets.join('\n'),
			'\t</Period>',
			'</MPD>',
			'',
		].join('\n');
	}
}
