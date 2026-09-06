/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { In } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { QueueService } from '@/core/QueueService.js';
import { VideoTranscodingProgressService } from '@/core/VideoTranscodingProgressService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:queue',
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileId: { type: 'string', format: 'misskey:id' },
	},
	required: ['fileId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private queueService: QueueService,
		private videoTranscodingProgressService: VideoTranscodingProgressService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// jobId は fileId と一致させている
			const job = await this.queueService.videoTranscodingQueue.getJob(ps.fileId);
			if (job != null) {
				// アクティブ（ロック中）ジョブは remove が失敗しうるため握りつぶす
				await job.remove().catch(() => { /* ignore */ });
			}

			await this.videoTranscodingProgressService.remove(ps.fileId);
			// pending/processing のジョブのみキャンセルし、既に completed/skipped のものは上書きしない
			// （完了直後のキャンセルで成果物URLを残したまま failed に壊すのを防ぐ）
			await this.driveFilesRepository.update(
				{ id: ps.fileId, transcodingStatus: In(['pending', 'processing']) },
				{ transcodingStatus: 'failed' },
			);
		});
	}
}
