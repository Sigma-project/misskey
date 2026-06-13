/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { VideoTranscodingProgressService } from '@/core/VideoTranscodingProgressService.js';
import { FFmpegCapabilityService } from '@/core/FFmpegCapabilityService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'read:admin:queue',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			capabilities: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					av1: { type: 'boolean', optional: false, nullable: false },
					vvc: { type: 'boolean', optional: false, nullable: false },
					opus: { type: 'boolean', optional: false, nullable: false },
					hls: { type: 'boolean', optional: false, nullable: false },
					dash: { type: 'boolean', optional: false, nullable: false },
				},
			},
			active: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
				},
			},
			failed: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						fileId: { type: 'string', optional: false, nullable: false },
						fileName: { type: 'string', optional: false, nullable: false },
						userId: { type: 'string', optional: false, nullable: true },
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private videoTranscodingProgressService: VideoTranscodingProgressService,
		private ffmpegCapabilityService: FFmpegCapabilityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const capabilities = await this.ffmpegCapabilityService.getCapabilities();
			const active = await this.videoTranscodingProgressService.listActive();

			const failedFiles = await this.driveFilesRepository.createQueryBuilder('file')
				.where('file.transcodingStatus = :status', { status: 'failed' })
				.orderBy('file.id', 'DESC')
				.limit(ps.limit)
				.getMany();

			const failed = failedFiles.map(file => ({
				fileId: file.id,
				fileName: file.name,
				userId: file.userId,
			}));

			return { capabilities, active, failed };
		});
	}
}
