/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { EntityManager } from 'typeorm';
import type { MiDriveFile } from '@/models/DriveFile.js';

/** Raw queries use the primary, or the caller's existing transaction connection. */
export async function hasEmojiFileReferences(
	manager: EntityManager,
	...files: (Pick<MiDriveFile, 'url' | 'webpublicUrl'> | null | undefined)[]
): Promise<boolean> {
	const urls = [...new Set(files.flatMap(file => [file?.url, file?.webpublicUrl])
		.filter((url): url is string => typeof url === 'string' && url.length > 0))];
	if (urls.length === 0) return false;

	const [result] = await manager.query(`SELECT EXISTS (
		SELECT 1 FROM emoji WHERE "originalUrl" = ANY($1::varchar[])
			OR "publicUrl" = ANY($1::varchar[])
	) AS referenced`, [urls]);
	return result.referenced;
}
