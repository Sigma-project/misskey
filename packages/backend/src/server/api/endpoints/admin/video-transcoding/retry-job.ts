/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { QueueService } from '@/core/QueueService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:queue',

	errors: {
		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: '9e6e6b7e-4a2b-4f3a-9d2a-1f6b1c6e2a01',
		},
		notTranscodable: {
			message: 'The file is not a local video and cannot be transcoded.',
			code: 'NOT_TRANSCODABLE',
			id: 'b3d6f0a2-1c3e-4b8a-8f2c-9a1e2d3c4b50',
		},
	},
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
	) {
		super(meta, paramDef, async (ps, me) => {
			const file = await this.driveFilesRepository.findOneBy({ id: ps.fileId });
			if (file == null) {
				throw new ApiError(meta.errors.noSuchFile);
			}
			// ローカルの動画ファイルのみ再投入対象
			if (file.userHost != null || file.isLink || !file.type.startsWith('video/')) {
				throw new ApiError(meta.errors.notTranscodable);
			}

			// jobId は fileId と一致するため、再投入前に既存ジョブを除去する
			const existing = await this.queueService.videoTranscodingQueue.getJob(ps.fileId);
			if (existing != null) {
				// A locked active job must remain cancelled until its worker has stopped.
				await existing.remove();
			}

			await this.driveFilesRepository.update(file.id, { transcodingStatus: 'pending' });
			await this.queueService.createVideoTranscodingJob(file.id);
		});
	}
}
