/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DriveService } from '@/core/DriveService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { EmojiEntityService } from '@/core/entities/EmojiEntityService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { QueueService } from '@/core/QueueService.js';
import DriveChart from '@/core/chart/charts/drive.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import PerUserDriveChart from '@/core/chart/charts/per-user-drive.js';
import { MiDriveFile, MiEmoji, MiMeta, MiUser } from '@/models/_.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { MiRemoteFileCleanup } from '@/models/RemoteFileCleanup.js';
import { CleanRemoteNoteFilesProcessorService } from '@/queue/processors/CleanRemoteNoteFilesProcessorService.js';
import type { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import AddEmojiEndpoint from '@/server/api/endpoints/admin/emoji/add.js';
import UpdateEmojiEndpoint from '@/server/api/endpoints/admin/emoji/update.js';
import { ApiError } from '@/server/api/error.js';

describe('emoji Drive file retention', () => {
	let app: TestingModule;
	let db: DataSource;
	let drive: DriveService;
	let emojis: CustomEmojiService;
	let entity: EmojiEntityService;
	let repository: DriveFilesRepository;
	let collector: CleanRemoteNoteFilesProcessorService;
	let add: AddEmojiEndpoint;
	let update: UpdateEmojiEndpoint;
	let me: MiLocalUser;
	const files: string[] = [];
	const emojiIds: string[] = [];

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] }).compile();
		db = app.get(DI.db);
		drive = app.get(DriveService);
		emojis = app.get(CustomEmojiService);
		entity = app.get(EmojiEntityService);
		repository = app.get(DI.driveFilesRepository);
		add = new AddEmojiEndpoint(repository, drive, emojis, entity);
		update = new UpdateEmojiEndpoint(repository, drive, emojis);
		const id = app.get(IdService).gen();
		await db.getRepository(MiUser).insert({ id, username: id, usernameLower: id });
		me = await db.getRepository(MiUser).findOneByOrFail({ id }) as MiLocalUser;
		const meta = app.get<MiMeta>(DI.meta);
		meta.enableRemoteNotesCleaning = true;
		collector = new CleanRemoteNoteFilesProcessorService(db, meta, drive, { logger: { warn: vi.fn() } } as unknown as QueueLoggerService);
	});

	beforeEach(() => {
		vi.spyOn(emojis.localEmojisCache, 'refresh').mockResolvedValue();
		vi.spyOn(app.get(GlobalEventService), 'publishBroadcastStream').mockImplementation(() => {});
		vi.spyOn(app.get(GlobalEventService), 'publishDriveStream').mockImplementation(() => {});
		vi.spyOn(app.get(ModerationLogService), 'log').mockResolvedValue();
		vi.spyOn(app.get(DriveChart), 'update').mockResolvedValue();
		vi.spyOn(app.get(InstanceChart), 'updateDrive').mockResolvedValue();
		vi.spyOn(app.get(PerUserDriveChart), 'update').mockResolvedValue();
		vi.spyOn(drive, 'deleteFileStorage').mockResolvedValue();
		vi.spyOn(drive, 'deleteObjectStorageFile').mockResolvedValue();
		vi.spyOn(app.get(InternalStorageService), 'del').mockImplementation(() => {});
		vi.spyOn(app.get(QueueService), 'createDeleteObjectStorageFileJob').mockResolvedValue(undefined as never);
		// The seven ID-based reference sources have their own DB/trigger tests.
		// The new Emoji URL query and both GC transactions remain real here.
		vi.spyOn(collector, 'hasReferences').mockResolvedValue(false);
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		if (emojiIds.length) await db.getRepository(MiEmoji).delete(emojiIds);
		if (files.length) {
			await db.getRepository(MiRemoteFileCleanup).delete(files);
			await db.getRepository(MiDriveFile).delete(files);
		}
		await db.getRepository(MiUser).delete(me.id);
		await app.close();
	});

	async function file(overrides: Partial<MiDriveFile> = {}) {
		const id = app.get(IdService).gen();
		files.push(id);
		await repository.insert({
			id, userId: null, userHost: 'remote.example', name: 'image.png', type: 'image/png',
			size: 100, md5: id, storedInternal: false, accessKey: id,
			url: `https://storage.example/${id}`, uri: `https://remote.example/${id}`,
			webpublicUrl: `https://storage.example/webpublic-${id}`, webpublicAccessKey: `webpublic-${id}`,
			webpublicType: 'image/jxl', ...overrides,
		});
		return repository.findOneByOrFail({ id });
	}

	async function emoji(target: MiDriveFile, overrides: Partial<MiEmoji> = {}) {
		const id = app.get(IdService).gen();
		emojiIds.push(id);
		await db.getRepository(MiEmoji).insert({
			id, name: `emoji${id}`, host: null, originalUrl: target.url,
			publicUrl: target.webpublicUrl ?? target.url, type: target.webpublicType ?? target.type,
			aliases: [], ...overrides,
		});
		return db.getRepository(MiEmoji).findOneByOrFail({ id });
	}

	async function addFrom(target: MiDriveFile) {
		const name = `added${app.get(IdService).gen()}`;
		try {
			return await add.exec({ name, fileId: target.id }, me, null);
		} finally {
			const created = await db.getRepository(MiEmoji).findOneBy({ name });
			if (created) emojiIds.push(created.id);
		}
	}

	test('registration copies a remote file before the source is collected', async () => {
		const source = await file();
		const copy = await file({ userHost: null });
		vi.spyOn(drive, 'uploadFromUrl').mockResolvedValue(copy);
		const created = await addFrom(source);
		expect(drive.uploadFromUrl).toHaveBeenCalledWith({ url: source.url, user: null, force: true });
		expect(await db.getRepository(MiEmoji).findOneByOrFail({ id: created.id })).toMatchObject({ originalUrl: copy.url, publicUrl: copy.webpublicUrl });
		await db.getRepository(MiRemoteFileCleanup).insert({ fileId: source.id });
		expect(await collector.collect(source.id)).toBe('deleted');
		expect(await repository.findOneBy({ id: copy.id })).not.toBeNull();
	});

	test('replacement copies the source even when the Emoji row has a remote host', async () => {
		const source = await file();
		const previous = await file({ userHost: null });
		const existing = await emoji(previous, { host: 'remote-emoji.example' });
		const copy = await file({ userHost: null });
		vi.spyOn(drive, 'uploadFromUrl').mockResolvedValue(copy);
		await update.exec({ id: existing.id, fileId: source.id }, me, null);
		expect(drive.uploadFromUrl).toHaveBeenCalledWith({ url: source.url, user: null, force: true });
		expect(await db.getRepository(MiEmoji).findOneByOrFail({ id: existing.id })).toMatchObject({ originalUrl: copy.url, publicUrl: copy.webpublicUrl });
	});

	test('local file registration and replacement keep using the selected file', async () => {
		const local = await file({ userHost: null, userId: me.id });
		vi.spyOn(drive, 'uploadFromUrl');
		const created = await addFrom(local);
		await update.exec({ id: created.id, fileId: local.id }, me, null);
		expect(drive.uploadFromUrl).not.toHaveBeenCalled();
		expect(await db.getRepository(MiEmoji).findOneByOrFail({ id: created.id })).toMatchObject({ originalUrl: local.url });
	});

	for (const operation of ['add', 'update'] as const) {
		test(`${operation} does not persist a copy whose downloaded type is not an image`, async () => {
			const source = await file();
			const existing = await emoji(await file({ userHost: null }));
			const copy = await file({ userHost: null, type: 'text/plain', webpublicType: null });
			vi.spyOn(drive, 'uploadFromUrl').mockResolvedValue(copy);
			const request = operation === 'add' ? addFrom(source) : update.exec({ id: existing.id, fileId: source.id }, me, null);
			await expect(request).rejects.toBeInstanceOf(ApiError);
			expect(await repository.findOneBy({ id: copy.id })).toBeNull();
			expect(await db.getRepository(MiEmoji).findOneByOrFail({ id: existing.id })).toMatchObject({ originalUrl: existing.originalUrl });
		});

		test(`${operation} retains a committed copy when post-write packing fails`, async () => {
			const source = await file();
			const existing = await emoji(await file({ userHost: null }));
			const copy = await file({ userHost: null });
			vi.spyOn(drive, 'uploadFromUrl').mockResolvedValue(copy);
			const packingError = new Error('post-commit packing failed');
			vi.spyOn(entity, 'packDetailed').mockRejectedValueOnce(packingError);
			const request = operation === 'add' ? addFrom(source) : update.exec({ id: existing.id, fileId: source.id }, me, null);
			await expect(request).rejects.toBe(packingError);
			expect(await repository.findOneBy({ id: copy.id })).not.toBeNull();
			expect(await db.getRepository(MiEmoji).existsBy({ originalUrl: copy.url })).toBe(true);
			expect(drive.deleteFileStorage).not.toHaveBeenCalled();
		});
	}

	test('download failure leaves the previous Emoji unchanged', async () => {
		const source = await file();
		const existing = await emoji(await file({ userHost: null }));
		vi.spyOn(drive, 'uploadFromUrl').mockRejectedValue(new Error('download failed'));
		await expect(update.exec({ id: existing.id, fileId: source.id }, me, null)).rejects.toBeInstanceOf(ApiError);
		expect(await db.getRepository(MiEmoji).findOneByOrFail({ id: existing.id })).toMatchObject({ originalUrl: existing.originalUrl });
		expect(drive.deleteFileStorage).not.toHaveBeenCalled();
	});

	test('an update error return reclaims only the unused dedicated copy', async () => {
		const source = await file();
		const copy = await file({ userHost: null });
		vi.spyOn(drive, 'uploadFromUrl').mockResolvedValue(copy);
		await expect(update.exec({ id: app.get(IdService).gen(), fileId: source.id }, me, null)).rejects.toMatchObject({ code: 'NO_SUCH_EMOJI' });
		expect(await repository.findOneBy({ id: copy.id })).toBeNull();
		expect(await repository.findOneBy({ id: source.id })).not.toBeNull();
	});

	test('an unknown primary reference state preserves the copy and the original API error', async () => {
		const source = await file();
		const copy = await file({ userHost: null });
		vi.spyOn(drive, 'uploadFromUrl').mockResolvedValue(copy);
		const writeError = new Error('emoji write failed');
		vi.spyOn(emojis, 'add').mockRejectedValue(writeError);
		vi.spyOn(repository.manager, 'query').mockRejectedValueOnce(new Error('primary unavailable'));
		await expect(addFrom(source)).rejects.toBe(writeError);
		expect(await repository.findOneBy({ id: copy.id })).not.toBeNull();
		expect(drive.deleteFileStorage).not.toHaveBeenCalled();
	});

	for (const state of ['pending', 'deleting'] as const) {
		for (const host of [null, 'remote-emoji.example']) {
			test(`${state} cleanup preserves an existing Emoji with host ${host} and resumes after its removal`, async () => {
				const source = await file();
				const existing = await emoji(source, { host });
				await db.getRepository(MiRemoteFileCleanup).insert({ fileId: source.id, state, descriptor: state === 'deleting' ? source : null });
				if (state === 'deleting') {
					// Cache expiry can already have replaced the current URLs; the stored
					// descriptor must still protect the Emoji's original storage keys.
					await repository.update(source.id, { url: source.uri!, webpublicUrl: null, isLink: true });
				}
				expect(await collector.collect(source.id)).toBe('deferred');
				expect(drive.deleteFileStorage).not.toHaveBeenCalled();
				expect(await db.getRepository(MiRemoteFileCleanup).findOneByOrFail({ fileId: source.id })).toMatchObject({ state, attempts: 1 });
				await db.getRepository(MiEmoji).delete(existing.id);
				await db.getRepository(MiRemoteFileCleanup).update(source.id, { nextAttemptAt: new Date(0) });
				expect(await collector.collect(source.id)).toBe('deleted');
				expect(await repository.findOneBy({ id: source.id })).toBeNull();
			});
		}
	}

	test('deleting candidates check the current URL as well as the saved descriptor', async () => {
		const descriptor = await file();
		await db.getRepository(MiRemoteFileCleanup).insert({ fileId: descriptor.id, state: 'deleting', descriptor });
		await repository.update(descriptor.id, { url: `${descriptor.url}-current`, webpublicUrl: null });
		const current = await repository.findOneByOrFail({ id: descriptor.id });
		await emoji(current);
		expect(await collector.collect(descriptor.id)).toBe('deferred');
		expect(drive.deleteFileStorage).not.toHaveBeenCalled();
	});

	test('a missing Drive row does not discard an Emoji-protected deleting descriptor', async () => {
		const descriptor = await file();
		await emoji(descriptor);
		await db.getRepository(MiRemoteFileCleanup).insert({ fileId: descriptor.id, state: 'deleting', descriptor });
		await repository.delete(descriptor.id);
		expect(await collector.collect(descriptor.id)).toBe('deferred');
		expect(await db.getRepository(MiRemoteFileCleanup).findOneByOrFail({ fileId: descriptor.id })).toMatchObject({ descriptor: { accessKey: descriptor.accessKey } });
		expect(drive.deleteFileStorage).not.toHaveBeenCalled();
	});

	for (const method of ['deleteFile', 'deleteFileSync'] as const) {
		for (const host of [null, 'remote-emoji.example']) {
			test(`${method} protects an Emoji public URL before remote cache expiry (host ${host})`, async () => {
				const source = await file();
				const existing = await emoji(source, { host, originalUrl: 'https://elsewhere.example/original' });
				await drive[method](source, true);
				expect(await repository.findOneByOrFail({ id: source.id })).toMatchObject({ url: source.url, isLink: false, isRemoteCacheExpired: false });
				expect(drive.deleteObjectStorageFile).not.toHaveBeenCalled();
				expect(app.get(InternalStorageService).del).not.toHaveBeenCalled();
				expect(app.get(QueueService).createDeleteObjectStorageFileJob).not.toHaveBeenCalled();
				expect(app.get(DriveChart).update).not.toHaveBeenCalled();
				await db.getRepository(MiEmoji).delete(existing.id);
				await drive[method](source, true);
				expect(await repository.findOneByOrFail({ id: source.id })).toMatchObject({ url: source.uri, isLink: true, isRemoteCacheExpired: true });
			});
		}
	}
});
