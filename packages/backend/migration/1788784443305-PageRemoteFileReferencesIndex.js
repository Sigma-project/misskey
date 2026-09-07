/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const concurrent = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';

export class PageRemoteFileReferencesIndex1788784443305 {
    name = 'PageRemoteFileReferencesIndex1788784443305';
    transaction = concurrent ? false : undefined;

    async up(queryRunner) {
        // A failed concurrent build can leave an invalid index. Repair that
        // state before retrying; a valid index makes the migration idempotent.
        const [existing] = await queryRunner.query(`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('"IDX_PAGE_REMOTE_FILE_REFERENCES"')`);
        if (existing?.indisvalid === true) return;
        await queryRunner.query('DROP INDEX IF EXISTS "IDX_PAGE_REMOTE_FILE_REFERENCES"');
        await queryRunner.query(`CREATE INDEX ${concurrent ? 'CONCURRENTLY' : ''} "IDX_PAGE_REMOTE_FILE_REFERENCES" ON page USING gin (
            (remote_file_cleanup_json_ids(content) || remote_file_cleanup_json_ids(variables) || ARRAY["eyeCatchingImageId"]::text[])
        )`);
        await queryRunner.query('ANALYZE page');
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX ${concurrent ? 'CONCURRENTLY' : ''} IF EXISTS "IDX_PAGE_REMOTE_FILE_REFERENCES"`);
    }
}
