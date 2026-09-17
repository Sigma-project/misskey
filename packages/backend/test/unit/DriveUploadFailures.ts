/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ReadStream, writeFileSync } from 'node:fs';
import { access, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DriveService } from '@/core/DriveService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { S3Service } from '@/core/S3Service.js';
import { QueueService } from '@/core/QueueService.js';
import { IdService } from '@/core/IdService.js';
import type { IImage } from '@/core/ImageProcessingService.js';
import { MiDriveFile, MiMeta } from '@/models/_.js';
import type { DriveFilesRepository } from '@/models/_.js';

type StorageSave = {
	generateAlts: () => Promise<{ webpublic: IImage | null; thumbnail: IImage | null }>;
	save: (file: MiDriveFile, path: string, name: string, type: string, hash: string, size: number) => Promise<MiDriveFile>;
};

describe('failed Drive uploads', () => {
	let app: TestingModule;
	let db: DataSource;
	let drive: StorageSave;
	let s3: S3Service;
	let internal: InternalStorageService;
	let repository: DriveFilesRepository;
	let meta: MiMeta;
	let directory: string;
	let path: string;
	const owned: string[] = [];
	const uploaded = new Set<string>();
	const streams = new Set<ReadStream>();
	const variant: IImage = { data: Buffer.from('variant'), ext: 'jxl', type: 'image/jxl' };

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] }).compile();
		db = app.get(DI.db);
		drive = app.get(DriveService) as unknown as StorageSave;
		s3 = app.get(S3Service);
		internal = app.get(InternalStorageService);
		repository = app.get(DI.driveFilesRepository);
		meta = app.get(DI.meta);
		directory = await mkdtemp(join(tmpdir(), 'drive-upload-failure-'));
		path = join(directory, 'source.png');
		await writeFile(path, 'original');
	});

	beforeEach(() => {
		uploaded.clear();
		meta.useObjectStorage = true;
		meta.objectStorageBucket = 'test-bucket';
		meta.objectStoragePrefix = '';
		meta.objectStorageBaseUrl = 'https://storage.example';
		vi.spyOn(drive, 'generateAlts').mockResolvedValue({ webpublic: variant, thumbnail: variant });
		vi.spyOn(s3, 'upload').mockImplementation(async (_meta, input) => {
			if (input.Body instanceof ReadStream) streams.add(input.Body);
			uploaded.add(input.Key!);
			return { Bucket: 'test-bucket', Key: input.Key, $metadata: {} };
		});
		vi.spyOn(s3, 'delete').mockImplementation(async (_meta, input) => {
			uploaded.delete(input.Key!);
			return { $metadata: {} };
		});
		vi.spyOn(app.get(QueueService), 'createDeleteObjectStorageFileJob').mockResolvedValue(undefined as never);
	});

	afterEach(() => {
		for (const stream of streams) stream.destroy();
		streams.clear();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		if (owned.length) await db.getRepository(MiDriveFile).delete(owned);
		await app.close();
		await rm(directory, { recursive: true, force: true });
	});

	function descriptor() {
		const id = app.get(IdService).gen();
		owned.push(id);
		return repository.create({ id, userId: null, userHost: null, isLink: false });
	}

	function save(file: MiDriveFile) {
		return drive.save(file, path, 'source.png', 'image/png', file.id, 8);
	}

	test('waits for a late successful PUT before reclaiming all keys after another PUT fails', async () => {
		const file = descriptor();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const failure = new Error('webpublic PUT failed');
		vi.mocked(s3.upload).mockImplementation(async (_meta, input) => {
			if (input.Body instanceof ReadStream) streams.add(input.Body);
			if (input.Key!.startsWith('webpublic-')) throw failure;
			if (input.Key!.startsWith('thumbnail-')) {
				entered.resolve();
				await resume.promise;
			}
			uploaded.add(input.Key!);
			return { Bucket: 'test-bucket', Key: input.Key, $metadata: {} };
		});
		const saving = save(file);
		const rejected = expect(saving).rejects.toBe(failure);
		try {
			await entered.promise;
			expect(s3.delete).not.toHaveBeenCalled();
		} finally {
			resume.resolve();
			await rejected;
		}
		expect(uploaded.size).toBe(0);
		expect(new Set(vi.mocked(s3.delete).mock.calls.map(([, input]) => input.Key))).toEqual(
			new Set(vi.mocked(s3.upload).mock.calls.map(([, input]) => input.Key)),
		);
		expect(s3.delete).toHaveBeenCalledTimes(3);
		expect(await repository.findOneBy({ id: file.id })).toBeNull();
	});

	test('an aborted upload result does not create a Drive row', async () => {
		const file = descriptor();
		vi.mocked(s3.upload).mockImplementation(async (_meta, input) => {
			if (input.Body instanceof ReadStream) streams.add(input.Body);
			return { $metadata: {} };
		});
		await expect(save(file)).rejects.toThrow('Upload Result Aborted');
		expect(s3.delete).toHaveBeenCalledTimes(3);
		expect(await repository.findOneBy({ id: file.id })).toBeNull();
	});

	test('failed cleanup queues every key and preserves the original upload error', async () => {
		const file = descriptor();
		const failure = new Error('PUT failed');
		vi.mocked(s3.upload).mockImplementation(async (_meta, input) => {
			if (input.Body instanceof ReadStream) streams.add(input.Body);
			throw failure;
		});
		vi.mocked(s3.delete).mockRejectedValue(new Error('DELETE failed'));
		await expect(save(file)).rejects.toBe(failure);
		expect(app.get(QueueService).createDeleteObjectStorageFileJob).toHaveBeenCalledTimes(3);
		expect(await repository.findOneBy({ id: file.id })).toBeNull();
	});

	test('a read failure after the Drive INSERT does not remove the committed storage', async () => {
		const file = descriptor();
		const failure = new Error('post-insert read failed');
		vi.spyOn(repository, 'insertOne').mockImplementation(async data => {
			await repository.insert(data);
			throw failure;
		});
		await expect(save(file)).rejects.toBe(failure);
		expect(uploaded.size).toBe(3);
		expect(s3.delete).not.toHaveBeenCalled();
		expect(await repository.findOneBy({ id: file.id })).not.toBeNull();
	});

	test('internal partial writes are removed before reporting failure and no row is inserted', async () => {
		meta.useObjectStorage = false;
		const file = descriptor();
		const written: string[] = [];
		const failure = new Error('variant write failed');
		vi.spyOn(internal, 'saveFromPath').mockImplementation(key => {
			written.push(key);
			writeFileSync(join(directory, key), 'original');
			return `https://storage.example/${key}`;
		});
		vi.spyOn(internal, 'saveFromBuffer').mockImplementation(key => {
			written.push(key);
			writeFileSync(join(directory, key), 'partial variant');
			throw failure;
		});
		vi.spyOn(internal, 'delAsync').mockImplementation(async key => {
			try {
				await unlink(join(directory, key));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			}
		});
		await expect(save(file)).rejects.toBe(failure);
		for (const key of written) await expect(access(join(directory, key))).rejects.toThrow();
		expect(internal.delAsync).toHaveBeenCalledTimes(3);
		expect(await repository.findOneBy({ id: file.id })).toBeNull();
	});
});
