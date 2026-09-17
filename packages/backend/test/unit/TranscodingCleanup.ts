/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { S3Service } from '@/core/S3Service.js';
import { TranscodingCleanupService } from '@/core/TranscodingCleanupService.js';
import { MiTranscodingCleanup } from '@/models/TranscodingCleanup.js';
import type { MiMeta } from '@/models/Meta.js';

describe('durable transcoding artifact cleanup', () => {
	let app: TestingModule;
	let db: DataSource;
	let service: TranscodingCleanupService;
	let s3: S3Service;
	let internal: InternalStorageService;
	const owned: string[] = [];

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] }).compile();
		db = app.get(DI.db);
		service = app.get(TranscodingCleanupService);
		s3 = app.get(S3Service);
		internal = app.get(InternalStorageService);
	});

	beforeEach(() => {
		vi.spyOn(s3, 'deletePrefix').mockResolvedValue();
		vi.spyOn(internal, 'delPrefixAsync').mockResolvedValue();
		vi.spyOn(service['logger'], 'warn').mockImplementation(() => {});
		vi.spyOn(service['logger'], 'info').mockImplementation(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (owned.length > 0) await db.getRepository(MiTranscodingCleanup).delete(owned.splice(0));
	});

	afterAll(async () => {
		await app.close();
	});

	async function create(artifacts: MiTranscodingCleanup['artifacts'] = [{ prefix: 'saved/stream', storedInternal: false }]) {
		const result = await db.transaction(manager => service.create(manager, app.get(IdService).gen(), artifacts.map(artifact => ({
			transcodingPrefix: artifact.prefix,
			transcodingStoredInternal: artifact.storedInternal,
		}))));
		if (!result) throw new Error('Missing cleanup record');
		owned.push(result.id);
		return result;
	}

	test('stores exact prefixes, deduplicates backend/prefix pairs, and creates a fresh record each time', async () => {
		const fileId = app.get(IdService).gen();
		const files = [
			{ transcodingPrefix: 'old-config/stream', transcodingStoredInternal: null },
			{ transcodingPrefix: 'old-config/stream', transcodingStoredInternal: false },
			{ transcodingPrefix: 'old-config/stream', transcodingStoredInternal: true },
			{ transcodingPrefix: null, transcodingStoredInternal: true },
		];
		for (let i = 0; i < 2; i++) {
			const record = await db.transaction(manager => service.create(manager, fileId, files));
			expect(record).not.toBeNull();
			owned.push(record!.id);
			expect(await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ id: record!.id })).toMatchObject({
				fileId, artifacts: [
					{ prefix: 'old-config/stream', storedInternal: false },
					{ prefix: 'old-config/stream', storedInternal: true },
				], attempts: 0, lastError: null,
			});
		}
		expect(owned[0]).not.toBe(owned[1]);
	});

	test('does not create records without artifacts, and honors the caller transaction rollback', async () => {
		const fileId = app.get(IdService).gen();
		await expect(db.transaction(manager => service.create(manager, fileId, [{ transcodingPrefix: null, transcodingStoredInternal: null }]))).resolves.toBeNull();
		const failure = new Error('Drive transaction failed');
		await expect(db.transaction(async manager => {
			const record = await service.create(manager, fileId, [{ transcodingPrefix: 'rolled-back/stream', transcodingStoredInternal: false }]);
			owned.push(record!.id);
			throw failure;
		})).rejects.toBe(failure);
		expect(await db.getRepository(MiTranscodingCleanup).countBy({ fileId })).toBe(0);
	});

	test('success removes only the outbox row and uses the stored backend and prefix', async () => {
		const record = await create([
			{ prefix: 'previous-config/stream', storedInternal: false },
			{ prefix: 'internal-stream', storedInternal: true },
		]);
		app.get<MiMeta>(DI.meta).objectStoragePrefix = 'new-config';
		const runners = vi.spyOn(db, 'createQueryRunner');
		await expect(service.collect(record.id)).resolves.toBe('deleted');
		expect(runners).toHaveBeenCalledWith('master');
		expect(s3.deletePrefix).toHaveBeenCalledWith(expect.anything(), 'previous-config/stream/', expect.any(AbortSignal));
		expect(internal.delPrefixAsync).toHaveBeenCalledWith('internal-stream');
		expect(await db.getRepository(MiTranscodingCleanup).findOneBy({ id: record.id })).toBeNull();
	});

	test('failure preserves every descriptor, tries the other backend, and retries idempotently', async () => {
		const record = await create([
			{ prefix: 'remote-stream', storedInternal: false },
			{ prefix: 'internal-stream', storedInternal: true },
		]);
		vi.mocked(s3.deletePrefix).mockRejectedValueOnce(new Error('temporary S3 failure'));
		await expect(service.collect(record.id)).resolves.toBe('deferred');
		expect(internal.delPrefixAsync).toHaveBeenCalledOnce();
		const pending = await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ id: record.id });
		expect(pending).toMatchObject({ artifacts: record.artifacts, attempts: 1 });
		expect(pending.lastError).toContain('temporary S3 failure');
		expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
		await db.getRepository(MiTranscodingCleanup).update(record.id, { nextAttemptAt: new Date(0) });
		await expect(service.collect(record.id)).resolves.toBe('deleted');
		expect(internal.delPrefixAsync).toHaveBeenCalledTimes(2);
	});

	test('waits for internal storage deletion before removing the record', async () => {
		const record = await create([{ prefix: 'internal-stream', storedInternal: true }]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.mocked(internal.delPrefixAsync).mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		const collecting = service.collect(record.id);
		try {
			await entered.promise;
			expect(await db.getRepository(MiTranscodingCleanup).findOneBy({ id: record.id })).not.toBeNull();
		} finally {
			release.resolve();
			await collecting;
		}
		expect(await db.getRepository(MiTranscodingCleanup).findOneBy({ id: record.id })).toBeNull();
	});

	test('aborts stalled S3 I/O and retains the complete shared-deadline descriptor', async () => {
		const record = await create([
			{ prefix: 'latest-stream', storedInternal: false },
			{ prefix: 'previous-stream', storedInternal: false },
		]);
		const controller = new AbortController();
		const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		const entered = Promise.withResolvers<void>();
		vi.mocked(s3.deletePrefix).mockImplementation(async (_meta, _prefix, signal) => {
			entered.resolve();
			await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
		});
		const collecting = service.collect(record.id);
		try {
			await entered.promise;
			controller.abort();
			await expect(collecting).resolves.toBe('deferred');
		} finally {
			controller.abort();
			await collecting;
		}
		expect(deadline).toHaveBeenCalledOnce();
		expect(s3.deletePrefix).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'latest-stream/', controller.signal);
		expect(await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ id: record.id })).toMatchObject({ artifacts: record.artifacts, attempts: 1 });
	});

	test('expired deadlines do not start storage I/O and retain the work', async () => {
		const record = await create();
		await expect(service.collect(record.id, Date.now() - 1)).resolves.toBe('deferred');
		expect(s3.deletePrefix).not.toHaveBeenCalled();
		expect(await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ id: record.id })).toMatchObject({ attempts: 1 });
	});

	test('missing and future records do not start storage I/O', async () => {
		const record = await create();
		await db.getRepository(MiTranscodingCleanup).update(record.id, { nextAttemptAt: new Date(Date.now() + 60 * 1000) });
		await expect(service.collect(record.id)).resolves.toBe('deferred');
		await expect(service.collect(app.get(IdService).gen())).resolves.toBe('skipped');
		expect(s3.deletePrefix).not.toHaveBeenCalled();
	});

	test('caps backoff at one day and truncates stored error details', async () => {
		const record = await create();
		await db.getRepository(MiTranscodingCleanup).update(record.id, { attempts: 30 });
		vi.mocked(s3.deletePrefix).mockRejectedValue(new Error('x'.repeat(5000)));
		const started = Date.now();
		await service.collect(record.id);
		const pending = await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ id: record.id });
		expect(pending.attempts).toBe(31);
		expect(pending.lastError).toHaveLength(4096);
		expect(pending.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(started + 24 * 60 * 60 * 1000);
		expect(pending.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
	});

	test('a late failed collector cannot recreate a record removed by a successful collector', async () => {
		const record = await create();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.mocked(s3.deletePrefix).mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error('late failure');
		});
		const failed = service.collect(record.id);
		try {
			await entered.promise;
			await expect(service.collect(record.id)).resolves.toBe('deleted');
		} finally {
			release.resolve();
			await failed;
		}
		expect(await db.getRepository(MiTranscodingCleanup).findOneBy({ id: record.id })).toBeNull();
	});

	test('simultaneous failures increment attempts from the current row', async () => {
		const record = await create();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		vi.mocked(s3.deletePrefix).mockImplementation(async () => {
			if (++calls === 2) entered.resolve();
			await release.promise;
			throw new Error('shared S3 failure');
		});
		const collecting = Promise.all([service.collect(record.id), service.collect(record.id)]);
		try {
			await entered.promise;
		} finally {
			release.resolve();
			await collecting;
		}
		expect(await db.getRepository(MiTranscodingCleanup).findOneByOrFail({ id: record.id })).toMatchObject({ attempts: 2 });
	});

	test('a one-connection pool runs batches and releases its connection during storage I/O', async () => {
		await create();
		const narrowDb = new DataSource({
			...db.options, synchronize: false, dropSchema: false,
			extra: { ...db.options.extra, max: 1, connectionTimeoutMillis: 1000 },
		});
		await narrowDb.initialize();
		try {
			const narrowService = new TranscodingCleanupService(
				narrowDb, app.get(DI.meta), app.get(IdService), internal, s3, app.get(LoggerService),
			);
			vi.mocked(s3.deletePrefix).mockImplementation(async () => {
				await narrowDb.query('SELECT 1');
			});
			await expect(narrowService.process()).resolves.toEqual({ deleted: 1, deferred: 0, skipped: 0, failed: 0 });
			expect(s3.deletePrefix).toHaveBeenCalledOnce();
		} finally {
			await narrowDb.destroy();
		}
	});

	test('periodic cleanup drains more than one batch without the remote-cleaning flag', async () => {
		app.get<MiMeta>(DI.meta).enableRemoteNotesCleaning = false;
		const records = Array.from({ length: 105 }, (_, index) => {
			const id = app.get(IdService).gen();
			owned.push(id);
			return { id, fileId: id, artifacts: [{ prefix: `stream-${index}`, storedInternal: false }], nextAttemptAt: new Date(0) };
		});
		await db.getRepository(MiTranscodingCleanup).insert(records);
		const future = await create();
		await db.getRepository(MiTranscodingCleanup).update(future.id, { nextAttemptAt: new Date(Date.now() + 60 * 1000) });
		await expect(service.process()).resolves.toEqual({ deleted: 105, deferred: 0, skipped: 0, failed: 0 });
		expect(await db.getRepository(MiTranscodingCleanup).findOneBy({ id: future.id })).not.toBeNull();
	});

	test('keyset progress skips a failing microsecond-timestamped batch instead of repeating it', async () => {
		const records = Array.from({ length: 101 }, () => {
			const id = app.get(IdService).gen();
			owned.push(id);
			return { id, fileId: id, artifacts: [{ prefix: 'stream', storedInternal: false }] };
		});
		await db.getRepository(MiTranscodingCleanup).insert(records);
		await db.query(`UPDATE transcoding_cleanup SET "nextAttemptAt" = '2020-01-01 00:00:00.123456+00' WHERE id = ANY($1::varchar[])`, [owned]);
		const collect = vi.spyOn(service, 'collect').mockRejectedValue(new Error('DB temporarily unavailable'));
		await expect(service.process()).resolves.toEqual({ deleted: 0, deferred: 0, skipped: 0, failed: 101 });
		expect(collect).toHaveBeenCalledTimes(101);
		expect(new Set(collect.mock.calls.map(([id]) => id)).size).toBe(101);
	});
});
