/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { GlobalEventService, type VideoTranscodingEventTypes } from '@/core/GlobalEventService.js';

export type VideoTranscodingProgress = VideoTranscodingEventTypes['progress'];

const INDEX_KEY = 'videoTranscoding:index';
const ACTIVE_KEY_PREFIX = 'videoTranscoding:active:';
const ACTIVE_TTL = 60 * 60 * 24; // 24h
const TERMINAL_TTL = 60; // 終端イベントは短時間だけ残す
const THROTTLE_MS = 1000;

@Injectable()
export class VideoTranscodingProgressService {
	// 同一ファイルの publish 間隔をスロットリングするための最終 publish 時刻（プロセスローカル）
	private lastPublishedAt = new Map<string, number>();

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private globalEventService: GlobalEventService,
	) {
	}

	private activeKey(fileId: string): string {
		return `${ACTIVE_KEY_PREFIX}${fileId}`;
	}

	private isTerminal(phase: VideoTranscodingProgress['phase']): boolean {
		return phase === 'done' || phase === 'failed' || phase === 'skipped';
	}

	/**
	 * 進捗を Redis スナップショットへ保存しつつ WebSocket で配信する。
	 * 終端フェーズと force 指定以外は最短 1 秒間隔にスロットリングする。
	 */
	@bindThis
	public async publishProgress(payload: VideoTranscodingProgress, opts?: { force?: boolean }): Promise<void> {
		const terminal = this.isTerminal(payload.phase);
		const last = this.lastPublishedAt.get(payload.fileId) ?? 0;
		if (!terminal && !opts?.force && payload.updatedAt - last < THROTTLE_MS) {
			return;
		}
		this.lastPublishedAt.set(payload.fileId, payload.updatedAt);

		const key = this.activeKey(payload.fileId);
		if (terminal) {
			// 終端は短い TTL で残し、index からは外す（一覧から自然に消える）
			await this.redisClient.set(key, JSON.stringify(payload), 'EX', TERMINAL_TTL);
			await this.redisClient.srem(INDEX_KEY, payload.fileId);
			this.lastPublishedAt.delete(payload.fileId);
		} else {
			await this.redisClient.set(key, JSON.stringify(payload), 'EX', ACTIVE_TTL);
			await this.redisClient.sadd(INDEX_KEY, payload.fileId);
		}

		this.globalEventService.publishVideoTranscodingStream('progress', payload);
	}

	/**
	 * 進行中ジョブのスナップショット一覧を返す。
	 * TTL 切れで本体が消えている index エントリは掃除する。
	 */
	@bindThis
	public async listActive(): Promise<VideoTranscodingProgress[]> {
		const ids = await this.redisClient.smembers(INDEX_KEY);
		if (ids.length === 0) return [];

		const values = await this.redisClient.mget(...ids.map(id => this.activeKey(id)));
		const result: VideoTranscodingProgress[] = [];
		const staleIds: string[] = [];

		for (let i = 0; i < ids.length; i++) {
			const v = values[i];
			if (v == null) {
				staleIds.push(ids[i]);
				continue;
			}
			try {
				result.push(JSON.parse(v) as VideoTranscodingProgress);
			} catch {
				staleIds.push(ids[i]);
			}
		}

		if (staleIds.length > 0) {
			await this.redisClient.srem(INDEX_KEY, ...staleIds);
		}

		return result;
	}

	/**
	 * スナップショットと index から該当ジョブを除去する（キャンセル時など）。
	 */
	@bindThis
	public async remove(fileId: string): Promise<void> {
		await this.redisClient.del(this.activeKey(fileId));
		await this.redisClient.srem(INDEX_KEY, fileId);
		this.lastPublishedAt.delete(fileId);
	}
}
