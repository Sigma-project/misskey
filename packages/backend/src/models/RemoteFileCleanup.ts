/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { MiDriveFile } from './DriveFile.js';
import { id } from './util/id.js';

@Entity('remote_file_cleanup')
export class MiRemoteFileCleanup {
	// No foreign key: storage descriptors must survive other Drive deletion paths.
	@PrimaryColumn({ ...id(), primaryKeyConstraintName: 'PK_REMOTE_FILE_CLEANUP' })
	public fileId: string;

	@Column('varchar', { length: 16, default: 'pending' })
	public state: 'pending' | 'deleting';

	@Column('timestamp with time zone', { default: () => 'CURRENT_TIMESTAMP' })
	public createdAt: Date;

	@Index('IDX_REMOTE_FILE_CLEANUP_NEXT_ATTEMPT')
	@Column('timestamp with time zone', { default: () => 'CURRENT_TIMESTAMP' })
	public nextAttemptAt: Date;

	@Column('integer', { default: 0 })
	public attempts: number;

	@Column('text', { nullable: true })
	public lastError: string | null;

	@Column('jsonb', { nullable: true })
	public descriptor: MiDriveFile | null;
}
