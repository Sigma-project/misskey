/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class TranscodingCleanup1789322972914 {
	name = 'TranscodingCleanup1789322972914';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "transcoding_cleanup" ("id" character varying(32) NOT NULL, "fileId" character varying(32) NOT NULL, "artifacts" jsonb NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "attempts" integer NOT NULL DEFAULT '0', "lastError" text, CONSTRAINT "PK_TRANSCODING_CLEANUP" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_TRANSCODING_CLEANUP_NEXT_ATTEMPT" ON "transcoding_cleanup"  ("nextAttemptAt", "id") `);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_TRANSCODING_CLEANUP_NEXT_ATTEMPT"`);
		await queryRunner.query(`DROP TABLE "transcoding_cleanup"`);
	}
}
