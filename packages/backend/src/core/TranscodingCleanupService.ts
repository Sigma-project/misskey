/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiMeta } from '@/models/Meta.js';
import { MiTranscodingCleanup } from '@/models/TranscodingCleanup.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import { IdService } from './IdService.js';
import { InternalStorageService } from './InternalStorageService.js';
import { LoggerService } from './LoggerService.js';
import { S3Service } from './S3Service.js';

@Injectable()
export class TranscodingCleanupService {
	private logger: Logger;

	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.meta) private meta: MiMeta,
		private idService: IdService,
		private internalStorageService: InternalStorageService,
		private s3Service: S3Service,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('transcoding-cleanup');
	}

	/** Persist inside the transaction that removes the corresponding Drive state. */
	@bindThis
	public async create(
		manager: EntityManager,
		fileId: string,
		files: readonly Pick<MiDriveFile, 'transcodingPrefix' | 'transcodingStoredInternal'>[],
	): Promise<MiTranscodingCleanup | null> {
		const artifacts: MiTranscodingCleanup['artifacts'] = [];
		for (const file of files) {
			if (file.transcodingPrefix == null) continue;
			const prefix = file.transcodingPrefix;
			const storedInternal = file.transcodingStoredInternal === true;
			if (!artifacts.some(artifact => artifact.prefix === prefix && artifact.storedInternal === storedInternal)) {
				artifacts.push({ prefix, storedInternal });
			}
		}
		if (artifacts.length === 0) return null;

		const record = manager.create(MiTranscodingCleanup, {
			id: this.idService.gen(), fileId, artifacts,
			createdAt: new Date(), nextAttemptAt: new Date(), attempts: 0, lastError: null,
		});
		await manager.insert(MiTranscodingCleanup, record);
		return record;
	}

	@bindThis
	public async collect(id: string, deadline = Date.now() + 30 * 1000): Promise<'deleted' | 'deferred' | 'skipped'> {
		const runner = this.db.createQueryRunner('master');
		let record: MiTranscodingCleanup | null;
		try {
			// Always read committed outbox rows from the primary, then release the connection.
			record = await runner.manager.findOneBy(MiTranscodingCleanup, { id });
		} finally {
			await runner.release();
		}
		if (!record) return 'skipped';
		if (record.nextAttemptAt > new Date()) return 'deferred';
		const budget = Math.min(30 * 1000, deadline - Date.now());
		const signal = budget > 0 ? AbortSignal.timeout(budget) : AbortSignal.abort(new Error('Transcoding cleanup deadline expired'));
		const errors: string[] = [];
		for (const artifact of record.artifacts) {
			try {
				signal.throwIfAborted();
				if (artifact.storedInternal) {
					await this.internalStorageService.delPrefixAsync(artifact.prefix);
				} else {
					await this.s3Service.deletePrefix(this.meta, `${artifact.prefix}/`, signal);
				}
			} catch (err) {
				errors.push(`${artifact.prefix}: ${String(err)}`);
				this.logger.warn(`Transcoding cleanup failed: ${record.id} (${artifact.prefix})`, err as Error);
			}
		}

		if (errors.length > 0) {
			// UPDATE cannot resurrect a concurrently removed record. Derive backoff
			// from the current row so simultaneous failures do not lose increments.
			await this.db.query(`UPDATE transcoding_cleanup SET
				attempts = LEAST(attempts + 1, 1000000),
				"nextAttemptAt" = CURRENT_TIMESTAMP + INTERVAL '1 second' * LEAST(86400, 60 * POWER(2.0, LEAST(attempts + 1, 11))),
				"lastError" = $2 WHERE id = $1`, [id, errors.join('\n').slice(0, 4096)]);
			return 'deferred';
		}
		// Prefixes are immutable and deletion is idempotent, so duplicate collectors are safe.
		await this.db.manager.delete(MiTranscodingCleanup, id);
		return 'deleted';
	}

	@bindThis
	public async process() {
		const start = Date.now();
		const cutoff = new Date(start);
		const stats = { deleted: 0, deferred: 0, skipped: 0, failed: 0 };
		let cursor: { nextAttemptAt: string; id: string } | undefined;
		while (Date.now() - start < 60 * 1000) {
			const runner = this.db.createQueryRunner('master');
			let batch: { entities: MiTranscodingCleanup[]; raw: { cursorAttemptAt: string }[] };
			try {
				const query = runner.manager.getRepository(MiTranscodingCleanup).createQueryBuilder('candidate')
					.where('candidate.nextAttemptAt <= :cutoff', { cutoff })
					.addSelect('candidate."nextAttemptAt"::text', 'cursorAttemptAt')
					.orderBy('candidate.nextAttemptAt', 'ASC').addOrderBy('candidate.id', 'ASC').take(100);
				if (cursor) query.andWhere('(candidate.nextAttemptAt, candidate.id) > (:nextAttemptAt, :id)', cursor);
				batch = await query.getRawAndEntities();
			} finally {
				await runner.release();
			}
			if (batch.entities.length === 0) break;
			for (const [index, candidate] of batch.entities.entries()) {
				if (Date.now() - start >= 60 * 1000) break;
				// Preserve PostgreSQL microseconds rather than rounding through JS Date.
				cursor = { nextAttemptAt: batch.raw[index].cursorAttemptAt, id: candidate.id };
				try {
					stats[await this.collect(candidate.id, start + 60 * 1000)]++;
				} catch (err) {
					stats.failed++;
					this.logger.warn(`Transcoding cleanup could not finish: ${candidate.id}`, err as Error);
				}
			}
		}
		this.logger.info(`Transcoding cleanup: ${JSON.stringify(stats)}`);
		return stats;
	}
}
