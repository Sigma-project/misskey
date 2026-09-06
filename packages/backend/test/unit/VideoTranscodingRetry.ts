/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../src/core/QueueService.js', () => ({ QueueService: class {} }));
const { default: RetryJob } = await import('@/server/api/endpoints/admin/video-transcoding/retry-job.js');
import type { DriveFilesRepository } from '@/models/_.js';
import type { QueueService } from '@/core/QueueService.js';
import type { MiLocalUser } from '@/models/User.js';

function harness(remove?: () => Promise<void>) {
	const file = { id: 'video1', userHost: null, isLink: false, type: 'video/mp4', transcodingStatus: 'failed' };
	const repository = {
		findOneBy: jest.fn(async () => file),
		update: jest.fn(async () => {}),
	};
	const queue = {
		videoTranscodingQueue: { getJob: jest.fn(async () => remove ? { remove } : null) },
		createVideoTranscodingJob: jest.fn(async () => {}),
	};
	const endpoint = new RetryJob(repository as unknown as DriveFilesRepository, queue as unknown as QueueService);
	return { repository, queue, run: () => endpoint.exec({ fileId: file.id }, {} as MiLocalUser, null) };
}

