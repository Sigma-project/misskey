/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, beforeEach, describe, test, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	DeleteObjectCommandOutput,
	InvalidObjectState,
	NoSuchKey,
	S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { GlobalModule } from '@/GlobalModule.js';
import { DriveService } from '@/core/DriveService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { S3Service } from '@/core/S3Service.js';
import { MiMeta } from '@/models/Meta.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { CoreModule } from '@/core/CoreModule.js';
import type { TestingModule } from '@nestjs/testing';

describe('DriveService', () => {
	let app: TestingModule;
	let driveService: DriveService;
	const s3Mock = mockClient(S3Client);

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [DriveService],
		}).compile();
		app.enableShutdownHooks();
		driveService = app.get<DriveService>(DriveService);
	});

	beforeEach(async () => {
		s3Mock.reset();
	});

	afterAll(async () => {
		await app.close();
	});

	describe('durable cleanup storage', () => {
		const descriptor = {
			id: 'remote', accessKey: 'original', thumbnailAccessKey: 'thumbnail',
			webpublicAccessKey: 'webpublic', storedInternal: false, isLink: false,
			transcodingPrefix: 'stream', transcodingStoredInternal: false,
		} as MiDriveFile;

		test('deletes originals, variants, and stream objects before resolving', async () => {
			s3Mock.on(DeleteObjectCommand).resolves({});
			s3Mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'stream/segment' }] });
			s3Mock.on(DeleteObjectsCommand).resolves({});
			await driveService.deleteFileStorage(descriptor);
			expect(s3Mock.commandCalls(DeleteObjectCommand).map(call => call.args[0].input.Key)).toEqual(['original', 'thumbnail', 'webpublic']);
			expect(s3Mock.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete?.Objects).toEqual([{ Key: 'stream/segment' }]);
		});

		test('per-object S3 batch errors propagate for durable retry', async () => {
			s3Mock.on(DeleteObjectCommand).resolves({});
			s3Mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'stream/segment' }] });
			s3Mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: 'stream/segment', Code: 'AccessDenied' }] });
			await expect(driveService.deleteFileStorage(descriptor)).rejects.toThrow('Failed to delete transcoding objects');
		});

		test('missing S3 keys are idempotent but other original failures propagate', async () => {
			s3Mock.on(DeleteObjectCommand).rejects(new NoSuchKey({ $metadata: {}, message: 'gone' }));
			s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
			await driveService.deleteFileStorage(descriptor);
			s3Mock.on(DeleteObjectCommand).rejects(new Error('unavailable'));
			await expect(driveService.deleteFileStorage(descriptor)).rejects.toThrow('Failed to delete the file');
		});

		test('link-only originals are untouched while independent stream storage is reclaimed', async () => {
			const internal = app.get(InternalStorageService);
			const prefix = vi.spyOn(internal, 'delPrefixAsync').mockResolvedValue();
			await driveService.deleteFileStorage({ ...descriptor, isLink: true, transcodingStoredInternal: true });
			expect(prefix).toHaveBeenCalledWith('stream');
			expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
		});

		test('internal original and variants use the awaited deletion path', async () => {
			const internal = app.get(InternalStorageService);
			const remove = vi.spyOn(internal, 'delAsync').mockResolvedValue();
			vi.spyOn(internal, 'delPrefixAsync').mockResolvedValue();
			await driveService.deleteFileStorage({ ...descriptor, storedInternal: true, transcodingStoredInternal: true });
			expect(remove.mock.calls.map(([key]) => key)).toEqual(['original', 'thumbnail', 'webpublic']);
			remove.mockRejectedValueOnce(new Error('read-only filesystem'));
			await expect(driveService.deleteFileStorage({ ...descriptor, storedInternal: true })).rejects.toThrow('read-only filesystem');
		});

		test('incomplete S3 listing cannot be marked collected', async () => {
			s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: true });
			await expect(app.get(S3Service).deletePrefix(new MiMeta(), 'stream/')).rejects.toThrow('continuation token');
		});

		test('stream deletion traverses S3 pages and accepts NoSuchKey batch responses', async () => {
			s3Mock.on(ListObjectsV2Command).resolvesOnce({ Contents: [{ Key: 'stream/a' }], IsTruncated: true, NextContinuationToken: 'next' }).resolves({ Contents: [{ Key: 'stream/b' }] });
			s3Mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Code: 'NoSuchKey' }] });
			await app.get(S3Service).deletePrefix(new MiMeta(), 'stream/');
			expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(2);
			expect(s3Mock.commandCalls(ListObjectsV2Command)[1].args[0].input.ContinuationToken).toBe('next');
		});
	});

	describe('Object storage', () => {
		test('delete a file', async () => {
			s3Mock.on(DeleteObjectCommand)
				.resolves({} as DeleteObjectCommandOutput);

			await driveService.deleteObjectStorageFile('peace of the world');
		});

		test('delete a file then unexpected error', async () => {
			s3Mock.on(DeleteObjectCommand)
				.rejects(new InvalidObjectState({ $metadata: {}, message: '' }));

			await expect(driveService.deleteObjectStorageFile('unexpected')).rejects.toThrow(Error);
		});

		test('delete a file with no valid key', async () => {
			// Some S3 implementations returns 404 Not Found on deleting with a non-existent key
			s3Mock.on(DeleteObjectCommand)
				.rejects(new NoSuchKey({ $metadata: {}, message: 'allowed error.' }));

			await driveService.deleteObjectStorageFile('lol no way');
		});
	});
});
