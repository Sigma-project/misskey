/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';

@Entity('transcoding_cleanup')
@Index('IDX_TRANSCODING_CLEANUP_NEXT_ATTEMPT', ['nextAttemptAt', 'id'])
export class MiTranscodingCleanup {
	@PrimaryColumn({ ...id(), primaryKeyConstraintName: 'PK_TRANSCODING_CLEANUP' })
	public id: string;

	// No foreign key: this record must survive deletion of the Drive file.
	@Column(id())
	public fileId: string;

	// Immutable descriptors include the storage prefix as it was originally saved.
	@Column('jsonb')
	public artifacts: { prefix: string; storedInternal: boolean }[];

	@Column('timestamp with time zone', { default: () => 'CURRENT_TIMESTAMP' })
	public createdAt: Date;

	@Column('timestamp with time zone', { default: () => 'CURRENT_TIMESTAMP' })
	public nextAttemptAt: Date;

	@Column('integer', { default: 0 })
	public attempts: number;

	@Column('text', { nullable: true })
	public lastError: string | null;
}
