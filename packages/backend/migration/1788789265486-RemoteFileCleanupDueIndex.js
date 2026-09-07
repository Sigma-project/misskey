/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RemoteFileCleanupDueIndex1788789265486 {
	name = 'RemoteFileCleanupDueIndex1788789265486';

	async up(queryRunner) {
		await queryRunner.query('DROP INDEX "IDX_REMOTE_FILE_CLEANUP_NEXT_ATTEMPT"');
		await queryRunner.query('CREATE INDEX "IDX_REMOTE_FILE_CLEANUP_NEXT_ATTEMPT" ON "remote_file_cleanup" ("nextAttemptAt", "fileId")');
	}

	async down(queryRunner) {
		await queryRunner.query('DROP INDEX "IDX_REMOTE_FILE_CLEANUP_NEXT_ATTEMPT"');
		await queryRunner.query('CREATE INDEX "IDX_REMOTE_FILE_CLEANUP_NEXT_ATTEMPT" ON "remote_file_cleanup" ("nextAttemptAt")');
	}
}
