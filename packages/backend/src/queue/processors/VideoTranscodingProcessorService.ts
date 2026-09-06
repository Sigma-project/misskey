/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as Path from 'node:path';
import * as crypto from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiMeta } from '@/models/Meta.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { createTemp, createTempDir } from '@/misc/create-temp.js';
import { MetaService } from '@/core/MetaService.js';
import { DownloadService } from '@/core/DownloadService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { S3Service } from '@/core/S3Service.js';
import { FFmpegCapabilityService } from '@/core/FFmpegCapabilityService.js';
import { VideoTranscodingService, TranscodeCancelledError, type TranscodingVariant } from '@/core/VideoTranscodingService.js';
import { VideoTranscodingProgressService, type VideoTranscodingProgress } from '@/core/VideoTranscodingProgressService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { VideoTranscodingJobData } from '../types.js';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';

const CONTENT_TYPES: Record<string, string> = {
	m3u8: 'application/vnd.apple.mpegurl',
	mpd: 'application/dash+xml',
	m4s: 'video/iso.segment',
	mp4: 'video/mp4',
};

// overallPercent のフェーズ別重み付け
// probing は別フェーズとして publish しない（duration/codec取得はアップロード時に済んでいる）ため downloading に含める
const WEIGHTS_WITH_VVC = { downloading: 7, 'encoding-av1': 50, 'encoding-vvc': 35, uploading: 8 };
const WEIGHTS_WITHOUT_VVC = { downloading: 7, 'encoding-av1': 85, 'encoding-vvc': 0, uploading: 8 };

@Injectable()
export class VideoTranscodingProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private metaService: MetaService,
		private downloadService: DownloadService,
		private internalStorageService: InternalStorageService,
		private s3Service: S3Service,
		private ffmpegCapabilityService: FFmpegCapabilityService,
		private videoTranscodingService: VideoTranscodingService,
		private videoTranscodingProgressService: VideoTranscodingProgressService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('video-transcoding');
	}

	@bindThis
	public async process(job: Bull.Job<VideoTranscodingJobData>): Promise<string> {
		const fileId = job.data.fileId;
		const file = await this.driveFilesRepository.findOneBy({ id: fileId });

		if (file == null) return 'skip: file not found';
		if (file.userHost != null) return 'skip: remote file';
		if (!file.type.startsWith('video/')) return 'skip: not a video';

		const meta = await this.metaService.fetch();
		const caps = await this.ffmpegCapabilityService.getCapabilities();
		const startedAt = Date.now();

		if (!meta.enableVideoTranscoding) {
			await this.markSkipped(file, caps.vvc, startedAt, 'transcoding disabled');
			return 'skip: transcoding disabled';
		}

		const maxFileSize = Number(meta.videoTranscodeMaxFileSize);
		if (maxFileSize > 0 && file.size > maxFileSize) {
			await this.markSkipped(file, caps.vvc, startedAt, 'file size exceeds the limit');
			return 'skip: file size exceeds the limit';
		}

		const durationSec = file.properties.duration ?? 0;
		// 長さ上限が設定されている場合、duration不明(検証不能) or 超過なら skip
		if (meta.videoTranscodeMaxDuration > 0 && (file.properties.duration == null || file.properties.duration > meta.videoTranscodeMaxDuration)) {
			await this.markSkipped(file, caps.vvc, startedAt, 'duration unknown or exceeds the limit');
			return 'skip: duration unknown or exceeds the limit';
		}

		if (!caps.av1 || !caps.hls) {
			await this.markSkipped(file, caps.vvc, startedAt, 'AV1 encoder or HLS muxer is not available');
			return 'skip: AV1/HLS not available';
		}

		// 再トランスコード時に旧成果物を後で掃除するため、現在のprefixを控えておく
		const oldPrefix = file.transcodingPrefix;
		const oldStoredInternal = file.transcodingStoredInternal ?? false;

		await this.driveFilesRepository.update(file.id, { transcodingStatus: 'processing' });
		await this.publish(file, caps.vvc, startedAt, 'queued', 0);

		const [inputPath, cleanupInput] = await createTemp();
		const [outDir, cleanupOutDir] = await createTempDir();

		const storedInternal = !meta.useObjectStorage;
		// アップロード済み成果物のストレージ上のプレフィックス（孤児掃除に使う）
		let storedPrefix: string | null = null;

		try {
			// --- download ---
			await this.publish(file, caps.vvc, startedAt, 'downloading', 0);
			if (file.storedInternal) {
				await fs.promises.copyFile(this.internalStorageService.resolvePath(file.accessKey!), inputPath);
			} else {
				await this.downloadService.downloadUrl(file.url, inputPath);
			}
			await this.publish(file, caps.vvc, startedAt, 'downloading', 100);

			// --- transcode ---
			const result = await this.videoTranscodingService.transcode({
				inputPath,
				outDir,
				durationSec,
				sourceVideoCodec: file.properties.videoCodec,
				maxOutputBytes: maxFileSize > 0 ? maxFileSize * 20 : undefined,
				// 協調キャンセル: cancel API が transcodingStatus を failed にする / ファイル削除済みなら中断
				shouldCancel: async () => {
					const current = await this.driveFilesRepository.findOneBy({ id: file.id });
					return current == null || current.transcodingStatus === 'failed';
				},
				onProgress: (p) => {
					void this.publish(file, caps.vvc, startedAt, p.phase, p.percent, { codec: p.codec, fps: p.fps, speed: p.speed });
				},
			});

			// --- upload ---
			await this.publish(file, caps.vvc, startedAt, 'uploading', 0);
			const rand = crypto.randomBytes(8).toString('hex');
			const logicalPrefix = `stream-${file.id}-${rand}`;
			const upload = await this.uploadArtifacts(outDir, logicalPrefix, storedInternal, meta, result.hasDash);
			storedPrefix = upload.storedPrefix;
			await this.publish(file, caps.vvc, startedAt, 'uploading', 100);

			// --- persist（processing のままの時だけ commit。cancel/delete とのraceを条件付きupdateで原子的に防ぐ） ---
			const updateResult = await this.driveFilesRepository.update(
				{ id: file.id, transcodingStatus: 'processing' },
				{
					hlsManifestUrl: result.hasHls ? upload.hlsUrl : null,
					dashManifestUrl: result.hasDash ? upload.dashUrl : null,
					transcodingStatus: 'completed',
					transcodingPrefix: storedPrefix,
					transcodingStoredInternal: storedInternal,
					transcodingVariants: result.variants,
				},
			);
			if (!updateResult.affected) {
				// cancel/delete された or status が変わった → アップロード済み成果物を破棄
				await this.cleanupArtifacts(storedPrefix, storedInternal, meta).catch(() => { /* ignore */ });
				storedPrefix = null;
				return 'aborted: cancelled or removed';
			}

			// 再トランスコード成功時、旧成果物を掃除（orphan化防止）
			if (oldPrefix != null && oldPrefix !== storedPrefix) {
				await this.cleanupArtifacts(oldPrefix, oldStoredInternal, meta).catch(() => { /* ignore */ });
			}

			await this.publish(file, caps.vvc, startedAt, 'done', 100);
			return 'Success';
		} catch (err) {
			// アップロード済み成果物の孤児化を防ぐ（コミット前に失敗/中断した場合）
			if (storedPrefix != null) {
				await this.cleanupArtifacts(storedPrefix, storedInternal, meta).catch(() => { /* ignore */ });
			}

			// キャンセル中断はリトライせず、status(既にfailed)も上書きしない
			if (err instanceof TranscodeCancelledError) {
				this.logger.info(`Transcoding cancelled for ${file.id}`);
				return 'aborted: cancelled';
			}

			this.logger.error(`Transcoding failed for ${file.id}`, err as Error);
			// 最終試行で失敗した場合のみ failed を確定させる
			const maxAttempts = job.opts.attempts ?? 1;
			if (job.attemptsMade + 1 >= maxAttempts) {
				await this.driveFilesRepository.update(file.id, { transcodingStatus: 'failed' });
				await this.publish(file, caps.vvc, startedAt, 'failed', 0, { message: (err as Error).message });
			}
			throw err;
		} finally {
			cleanupInput();
			cleanupOutDir();
		}
	}

	/**
	 * outDir 配下を再帰的にストレージへアップロードし、master/manifest の公開URLと
	 * クリーンアップ用の storedPrefix を返す。
	 *
	 * storedPrefix は削除時に objectStoragePrefix の変更に依存しないよう、保存時の実プレフィックスを返す:
	 * - 内部ストレージ: 論理 prefix（配信ルート用に `stream-...` のまま）
	 * - ObjectStorage: objectStoragePrefix を含む実キー prefix
	 */
	@bindThis
	private async uploadArtifacts(outDir: string, logicalPrefix: string, storedInternal: boolean, meta: MiMeta, hasDash: boolean): Promise<{ hlsUrl: string; dashUrl: string; storedPrefix: string }> {
		const files = await this.collectFiles(outDir, '');

		if (storedInternal) {
			for (const rel of files) {
				this.internalStorageService.saveFromPath(`${logicalPrefix}/${rel}`, Path.join(outDir, rel));
			}
			return {
				hlsUrl: `${this.config.url}/transcoded/${logicalPrefix}/master.m3u8`,
				dashUrl: `${this.config.url}/transcoded/${logicalPrefix}/manifest.mpd`,
				storedPrefix: logicalPrefix,
			};
		}

		// ObjectStorage
		const baseUrl = meta.objectStorageBaseUrl
			?? `${meta.objectStorageUseSSL ? 'https' : 'http'}://${meta.objectStorageEndpoint}${meta.objectStoragePort ? `:${meta.objectStoragePort}` : ''}/${meta.objectStorageBucket}`;
		const storedPrefix = (meta.objectStoragePrefix ? `${meta.objectStoragePrefix}/` : '') + logicalPrefix;
		const keyBase = `${storedPrefix}/`;

		for (const rel of files) {
			const ext = rel.split('.').pop()?.toLowerCase() ?? '';
			const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
			const isManifest = ext === 'm3u8' || ext === 'mpd';

			const params = {
				Bucket: meta.objectStorageBucket,
				Key: `${keyBase}${rel}`,
				Body: fs.createReadStream(Path.join(outDir, rel)),
				ContentType: contentType,
				CacheControl: isManifest ? 'max-age=10' : 'max-age=31536000, immutable',
			} as PutObjectCommandInput;
			if (meta.objectStorageSetPublicRead) params.ACL = 'public-read';

			await this.s3Service.upload(meta, params);
		}

		return {
			hlsUrl: `${baseUrl}/${keyBase}master.m3u8`,
			dashUrl: `${baseUrl}/${keyBase}manifest.mpd`,
			storedPrefix,
		};
	}

	/**
	 * アップロード済みのトランスコード成果物を storedPrefix 単位で削除する（失敗/キャンセル時の孤児掃除）。
	 */
	@bindThis
	private async cleanupArtifacts(storedPrefix: string, storedInternal: boolean, meta: MiMeta): Promise<void> {
		if (storedInternal) {
			this.internalStorageService.delPrefix(storedPrefix);
		} else {
			await this.s3Service.deletePrefix(meta, `${storedPrefix}/`);
		}
	}

	/**
	 * dir 配下のファイルを相対パスの配列として再帰的に収集する。
	 */
	@bindThis
	private async collectFiles(dir: string, rel: string): Promise<string[]> {
		const entries = await fs.promises.readdir(Path.join(dir, rel), { withFileTypes: true });
		const result: string[] = [];
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				result.push(...await this.collectFiles(dir, childRel));
			} else if (entry.isFile()) {
				result.push(childRel);
			}
		}
		return result;
	}

	@bindThis
	private async markSkipped(file: MiDriveFile, vvcAvailable: boolean, startedAt: number, message: string): Promise<void> {
		await this.driveFilesRepository.update(file.id, { transcodingStatus: 'skipped' });
		await this.publish(file, vvcAvailable, startedAt, 'skipped', 0, { message });
	}

	@bindThis
	private async publish(
		file: MiDriveFile,
		vvcAvailable: boolean,
		startedAt: number,
		phase: VideoTranscodingProgress['phase'],
		phasePercent: number,
		extra?: { codec?: 'av1' | 'vvc'; fps?: number; speed?: string; message?: string },
	): Promise<void> {
		const payload: VideoTranscodingProgress = {
			fileId: file.id,
			userId: file.userId,
			fileName: file.name,
			phase,
			percent: Math.round(phasePercent),
			overallPercent: this.computeOverall(vvcAvailable, phase, phasePercent),
			codec: extra?.codec,
			fps: extra?.fps,
			speed: extra?.speed,
			message: extra?.message,
			startedAt,
			updatedAt: Date.now(),
		};
		await this.videoTranscodingProgressService.publishProgress(payload).catch(() => { /* ignore */ });
	}

	/**
	 * フェーズ別の重みを使って全体進捗(0-100)を算出する。
	 */
	@bindThis
	private computeOverall(vvcAvailable: boolean, phase: VideoTranscodingProgress['phase'], phasePercent: number): number {
		if (phase === 'done') return 100;
		if (phase === 'skipped' || phase === 'failed') return 0;

		const weights = vvcAvailable ? WEIGHTS_WITH_VVC : WEIGHTS_WITHOUT_VVC;
		const order: (keyof typeof weights)[] = ['downloading', 'encoding-av1', 'encoding-vvc', 'uploading'];

		// queued は 0
		if (phase === 'queued') return 0;

		let base = 0;
		for (const ph of order) {
			if (ph === phase) break;
			base += weights[ph];
		}
		const current = (weights[phase as keyof typeof weights] ?? 0) * (Math.max(0, Math.min(100, phasePercent)) / 100);
		return Math.round(Math.max(0, Math.min(100, base + current)));
	}
}
