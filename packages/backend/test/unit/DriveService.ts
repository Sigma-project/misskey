/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, beforeEach, describe, test, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { MiUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { MiRemoteFileCleanup } from '@/models/RemoteFileCleanup.js';
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
import { MiDriveFile } from '@/models/DriveFile.js';
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

	test('re-registers the same remote URI and content while the old row is deleting', async () => {
		const db = app.get<DataSource>(DI.db);
		const id = app.get(IdService).gen();
		const user = { id, host: 'remote.example' };
		await db.getRepository(MiUser).insert({ ...user, username: id, usernameLower: id });
		await db.getRepository(MiUserProfile).insert({ userId: id });
		const directory = await mkdtemp(join(tmpdir(), 'remote-reimport-'));
		const path = join(directory, 'file.txt');
		await writeFile(path, 'The same remote attachment');
		const uri = 'https://remote.example/file.txt';
		try {
			const first = await driveService.addFile({ user, path, isLink: true, uri, url: uri, name: 'file.txt' });
			await db.getRepository(MiRemoteFileCleanup).insert({ fileId: first.id, state: 'deleting', descriptor: first, lastError: 'storage unavailable' });
			const second = await driveService.addFile({ user, path, isLink: true, uri, url: uri, name: 'file.txt' });
			expect(second.id).not.toBe(first.id);
			expect(second.uri).toBe(first.uri);
			expect(second.md5).toBe(first.md5);
			expect(second.accessKey).not.toBe(first.accessKey);
			expect(await db.getRepository(MiDriveFile).countBy({ uri, userId: id })).toBe(2);
			await db.getRepository(MiRemoteFileCleanup).delete(first.id);
		} finally {
			await db.getRepository(MiDriveFile).delete({ userId: id });
			await db.getRepository(MiUser).delete(id);
			await rm(directory, { recursive: true, force: true });
		}
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
