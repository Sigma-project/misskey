/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class EmojiFileReferenceIndexes1789315200796 {
	name = 'EmojiFileReferenceIndexes1789315200796';

	async up(queryRunner) {
		await queryRunner.query('CREATE INDEX "IDX_EMOJI_ORIGINAL_URL" ON "emoji" ("originalUrl")');
		await queryRunner.query('CREATE INDEX "IDX_EMOJI_PUBLIC_URL" ON "emoji" ("publicUrl")');
	}

	async down(queryRunner) {
		await queryRunner.query('DROP INDEX "IDX_EMOJI_PUBLIC_URL"');
		await queryRunner.query('DROP INDEX "IDX_EMOJI_ORIGINAL_URL"');
	}
}
