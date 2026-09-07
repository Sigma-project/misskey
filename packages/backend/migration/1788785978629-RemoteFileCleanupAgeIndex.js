/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RemoteFileCleanupAgeIndex1788785978629 {
	name = 'RemoteFileCleanupAgeIndex1788785978629';

	async up(queryRunner) {
		await queryRunner.query('CREATE INDEX "IDX_REMOTE_FILE_CLEANUP_CREATED_AT" ON remote_file_cleanup ("createdAt")');
	}

	async down(queryRunner) {
		await queryRunner.query('DROP INDEX "IDX_REMOTE_FILE_CLEANUP_CREATED_AT"');
	}
}
