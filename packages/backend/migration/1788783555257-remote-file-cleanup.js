/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RemoteFileCleanup1788783555257 {
	name = 'RemoteFileCleanup1788783555257';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "remote_file_cleanup" ("fileId" character varying(32) NOT NULL, "state" character varying(16) NOT NULL DEFAULT 'pending', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "attempts" integer NOT NULL DEFAULT 0, "lastError" text, "descriptor" jsonb, CONSTRAINT "PK_REMOTE_FILE_CLEANUP" PRIMARY KEY ("fileId"))`);
		await queryRunner.query(`CREATE INDEX "IDX_REMOTE_FILE_CLEANUP_NEXT_ATTEMPT" ON "remote_file_cleanup" ("nextAttemptAt")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "remote_file_cleanup"`);
	}
}
