/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiRemoteFileCleanup } from '@/models/RemoteFileCleanup.js';
import type { MiMeta } from '@/models/Meta.js';
import { DriveService } from '@/core/DriveService.js';
import { bindThis } from '@/decorators.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

@Injectable()
export class CleanRemoteNoteFilesProcessorService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.meta) private meta: MiMeta,
		private driveService: DriveService,
		private queueLoggerService: QueueLoggerService,
	) {}

	@bindThis
	public async hasReferences(manager: EntityManager, fileId: string): Promise<boolean> {
		const [result] = await manager.query(`SELECT
			EXISTS (SELECT 1 FROM note WHERE "fileIds" @> ARRAY[$1]::varchar[]) OR
			EXISTS (SELECT 1 FROM note_draft WHERE "fileIds" @> ARRAY[$1]::varchar[]) OR
			EXISTS (SELECT 1 FROM gallery_post WHERE "fileIds" @> ARRAY[$1]::varchar[]) OR
			EXISTS (SELECT 1 FROM "user" WHERE "avatarId" = $1 OR "bannerId" = $1) OR
			EXISTS (SELECT 1 FROM channel WHERE "bannerId" = $1) OR
			EXISTS (SELECT 1 FROM chat_message WHERE "fileId" = $1) OR
			EXISTS (SELECT 1 FROM page WHERE
				(remote_file_cleanup_json_ids(content) || remote_file_cleanup_json_ids(variables)
					|| ARRAY["eyeCatchingImageId"]::text[]) @> ARRAY[$1]::text[])
			AS referenced`, [fileId]);
		return result.referenced;
	}

	private async postpone(manager: EntityManager, candidate: MiRemoteFileCleanup, error: string | null) {
		const attempts = Math.min(candidate.attempts + 1, 1000000);
		await manager.update(MiRemoteFileCleanup, candidate.fileId, {
			attempts,
			nextAttemptAt: new Date(Date.now() + Math.min(24 * 60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(attempts, 11))),
			lastError: error?.slice(0, 4096) ?? null,
		});
	}

	/** Each file has a session lock spanning storage I/O and the two short transactions. */
	@bindThis
	public async collect(fileId: string): Promise<'deleted' | 'deferred' | 'skipped'> {
		const runner = this.db.createQueryRunner();
		await runner.connect();
		let locked = false;
		try {
			const [lock] = await runner.query('SELECT pg_try_advisory_lock(hashtextextended($1, 18)) AS locked', [fileId]);
			locked = lock.locked;
			if (!locked) return 'skipped';

			const descriptor = await runner.manager.transaction(async manager => {
				await manager.query("SET LOCAL lock_timeout = '5s'");
				await manager.query("SET LOCAL statement_timeout = '30s'");
				// Readers take FOR SHARE in their reference-writing transaction. Acquire the
				// exclusive lock first, then use a NEW READ COMMITTED snapshot to inspect refs.
				const file = await manager.findOne(MiDriveFile, { where: { id: fileId }, lock: { mode: 'pessimistic_write' } });
				const candidate = await manager.findOneBy(MiRemoteFileCleanup, { fileId });
				if (!candidate || candidate.nextAttemptAt > new Date()) return null;
				if (candidate.state === 'deleting') {
					if (!candidate.descriptor) throw new Error('Deleting candidate has no storage descriptor');
					return candidate.descriptor;
				}
				if (!file || file.userHost == null) {
					await manager.delete(MiRemoteFileCleanup, fileId);
					return null;
				}
				if (!this.meta.enableRemoteNotesCleaning) return null;
				if (await this.hasReferences(manager, fileId)) {
					await this.postpone(manager, candidate, null);
					return null;
				}
				await manager.update(MiRemoteFileCleanup, fileId, { state: 'deleting', descriptor: file });
				return file;
			});
			if (!descriptor) return 'deferred';

			// A crash or partial failure leaves all keys in the deleting descriptor.
			await this.driveService.deleteFileStorage(descriptor);
			const deleted = await runner.manager.transaction(async manager => {
				const result = await manager.createQueryBuilder().delete().from(MiDriveFile)
					.where('id = :fileId', { fileId }).returning('*').execute();
				await manager.delete(MiRemoteFileCleanup, fileId);
				return (result.raw as MiDriveFile[])[0];
			});
			if (deleted) {
				// Same best-effort chart/stream semantics as normal Drive deletion; never
				// repeat storage deletion because a notification failed after commit.
				try {
					await this.driveService.notifyFileDeleted(deleted);
				} catch (err) {
					this.queueLoggerService.logger.warn(`Remote file cleanup notification failed: ${fileId}`, err as Error);
				}
			}
			return 'deleted';
		} catch (err) {
			const candidate = await runner.manager.findOneBy(MiRemoteFileCleanup, { fileId });
			if (candidate) await this.postpone(runner.manager, candidate, String(err));
			throw err;
		} finally {
			try {
				if (locked) await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 18))', [fileId]);
			} finally {
				await runner.release();
			}
		}
	}

	@bindThis
	public async process() {
		const logger = this.queueLoggerService.logger.createSubLogger('clean-remote-note-files');
		const start = Date.now();
		const repository = this.db.getRepository(MiRemoteFileCleanup);
		const cutoff = new Date(start);
		const stats = { deleted: 0, deferred: 0, skipped: 0, failed: 0 };
		let cursor: { nextAttemptAt: string; fileId: string } | undefined;
		// Bound memory per query, not successful collections per invocation. This
		// lets fast storage drain more than 100 files within the same time budget.
		// A keyset cursor also prevents locked files from busy-looping this run.
		while (Date.now() - start < 60 * 1000) {
			const query = repository.createQueryBuilder('candidate')
				.where('candidate.nextAttemptAt <= :cutoff', { cutoff })
				.addSelect('candidate."nextAttemptAt"::text', 'cursorAttemptAt')
				.orderBy('candidate.nextAttemptAt', 'ASC').addOrderBy('candidate.fileId', 'ASC').take(100);
			if (cursor) query.andWhere('(candidate.nextAttemptAt, candidate.fileId) > (:nextAttemptAt, :fileId)', cursor);
			if (!this.meta.enableRemoteNotesCleaning) query.andWhere("candidate.state = 'deleting'");
			const { entities: candidates, raw } = await query.getRawAndEntities();
			if (candidates.length === 0) break;
			for (const [index, candidate] of candidates.entries()) {
				if (Date.now() - start >= 60 * 1000) break;
				// Preserve PostgreSQL microseconds; JS Date truncation could repeat a batch.
				cursor = { nextAttemptAt: raw[index].cursorAttemptAt, fileId: candidate.fileId };
				try {
					stats[await this.collect(candidate.fileId)]++;
				} catch (err) {
					stats.failed++;
					logger.warn(`Remote file cleanup failed: ${candidate.fileId}`, err as Error);
				}
			}
		}

		const remaining = await repository.count();
		const oldest = await repository.findOne({ where: {}, order: { createdAt: 'ASC' } });
		logger.info(`Remote file cleanup: ${JSON.stringify({ ...stats, remaining, oldest: oldest?.createdAt ?? null })}`);
		return stats;
	}
}
