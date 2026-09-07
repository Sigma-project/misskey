/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Raw } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';
import type { DriveFilesRepository, MiDriveFile } from '@/models/_.js';

/** The reference-write trigger closes the race after this lookup returns. */
export function findReusableDriveFile(repository: DriveFilesRepository, where: Omit<FindOptionsWhere<MiDriveFile>, 'id'>): Promise<MiDriveFile | null> {
	return repository.findOneBy({
		...where,
		id: Raw(column => `NOT EXISTS (SELECT 1 FROM remote_file_cleanup cleanup WHERE cleanup."fileId" = ${column} AND cleanup.state = 'deleting')`),
	});
}
