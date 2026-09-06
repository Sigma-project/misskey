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

describe('video transcoding retry', () => {
	test('keeps cancellation intact when a running job is still locked', async () => {
		const failure = new Error('Job is locked');
		const ctx = harness(async () => { throw failure; });
		await expect(ctx.run()).rejects.toThrow('Job is locked');
		expect(ctx.repository.update).not.toHaveBeenCalled();
		expect(ctx.queue.createVideoTranscodingJob).not.toHaveBeenCalled();
	});

	test('waits for removal to finish before marking pending and enqueuing', async () => {
		let finish!: () => void;
		const pending = new Promise<void>(resolve => { finish = resolve; });
		const ctx = harness(() => pending);
		const retry = ctx.run();
		await Promise.resolve();
		await Promise.resolve();
		expect(ctx.repository.update).not.toHaveBeenCalled();
		expect(ctx.queue.createVideoTranscodingJob).not.toHaveBeenCalled();
		finish();
		await retry;
		expect(ctx.repository.update).toHaveBeenCalledWith('video1', { transcodingStatus: 'pending' });
		expect(ctx.queue.createVideoTranscodingJob).toHaveBeenCalledWith('video1');
	});

	test('retries a cancelled file after the old job has already disappeared', async () => {
		const ctx = harness();
		await ctx.run();
		expect(ctx.repository.update).toHaveBeenCalledWith('video1', { transcodingStatus: 'pending' });
		expect(ctx.queue.createVideoTranscodingJob).toHaveBeenCalledWith('video1');
	});
});
