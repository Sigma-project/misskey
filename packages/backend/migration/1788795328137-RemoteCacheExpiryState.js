/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RemoteCacheExpiryState1788795328137 {
	name = 'RemoteCacheExpiryState1788795328137';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "drive_file" ADD "isRemoteCacheExpired" boolean NOT NULL DEFAULT false');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "drive_file" DROP COLUMN "isRemoteCacheExpired"');
	}
}
