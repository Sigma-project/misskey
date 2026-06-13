/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class VideoTranscoding1781340911000 {
    name = 'VideoTranscoding1781340911000'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "drive_file" ADD "hlsManifestUrl" character varying(512)`);
        await queryRunner.query(`ALTER TABLE "drive_file" ADD "dashManifestUrl" character varying(512)`);
        await queryRunner.query(`ALTER TABLE "drive_file" ADD "transcodingStatus" character varying(16)`);
        await queryRunner.query(`ALTER TABLE "drive_file" ADD "transcodingPrefix" character varying(256)`);
        await queryRunner.query(`ALTER TABLE "drive_file" ADD "transcodingStoredInternal" boolean`);
        await queryRunner.query(`ALTER TABLE "drive_file" ADD "transcodingVariants" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "meta" ADD "enableVideoTranscoding" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "meta" ADD "videoTranscodeMaxFileSize" bigint NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "meta" ADD "videoTranscodeMaxDuration" integer NOT NULL DEFAULT 0`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "videoTranscodeMaxDuration"`);
        await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "videoTranscodeMaxFileSize"`);
        await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "enableVideoTranscoding"`);
        await queryRunner.query(`ALTER TABLE "drive_file" DROP COLUMN "transcodingVariants"`);
        await queryRunner.query(`ALTER TABLE "drive_file" DROP COLUMN "transcodingStoredInternal"`);
        await queryRunner.query(`ALTER TABLE "drive_file" DROP COLUMN "transcodingPrefix"`);
        await queryRunner.query(`ALTER TABLE "drive_file" DROP COLUMN "transcodingStatus"`);
        await queryRunner.query(`ALTER TABLE "drive_file" DROP COLUMN "dashManifestUrl"`);
        await queryRunner.query(`ALTER TABLE "drive_file" DROP COLUMN "hlsManifestUrl"`);
    }
}
