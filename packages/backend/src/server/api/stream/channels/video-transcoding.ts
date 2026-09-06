/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import { RoleService } from '@/core/RoleService.js';
import type { JsonObject, JsonValue } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class VideoTranscodingChannel extends Channel {
	public readonly chName = 'videoTranscoding';
	public static shouldShare = true;
	public static requireCredential = true as const;
	public static kind = 'read:admin:queue';

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private roleService: RoleService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject) {
		// Connection 側の kind チェックはトークン認証時のみ効くため、
		// セッション認証でも漏れないようチャンネル側でモデレーター権限を明示的に検証する。
		// （本チャンネルは全体ブロードキャストを購読するため、ユーザー別チャンネルと違い権限バイパスが情報漏洩に直結する）
		const isModerator = await this.roleService.isModerator(this.user ?? null);
		if (!isModerator) return;

		this.subscriber.on('videoTranscodingStream', this.onEvent);
	}

	@bindThis
	private onEvent(data: { type: string; body: JsonValue }) {
		this.send(data);
	}

	@bindThis
	public dispose() {
		this.subscriber.off('videoTranscodingStream', this.onEvent);
	}
}
