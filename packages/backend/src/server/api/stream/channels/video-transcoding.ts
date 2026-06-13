/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
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
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject) {
		// 全モデレーターが同一のブロードキャストチャンネルを購読する
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
