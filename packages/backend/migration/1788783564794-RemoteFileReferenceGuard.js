/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RemoteFileReferenceGuard1788783564794 {
    name = 'RemoteFileReferenceGuard1788783564794';

    async up(queryRunner) {
        // Page content and variables may contain other users' files. Use the same
        // extractor in the collector and writer guard, including nested blocks.
        await queryRunner.query(`CREATE FUNCTION remote_file_cleanup_json_ids(document jsonb)
            RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
            WITH RECURSIVE nodes(value) AS (
                SELECT document
                UNION ALL
                SELECT child.value FROM nodes
                CROSS JOIN LATERAL (
                    SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END)
                    UNION ALL
                    SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(nodes.value) = 'array' THEN nodes.value ELSE '[]'::jsonb END)
                ) child
            ), ids(id) AS (
                SELECT value->>'fileId' FROM nodes WHERE jsonb_typeof(value->'fileId') = 'string'
                UNION
                SELECT item #>> '{}' FROM nodes CROSS JOIN LATERAL
                    jsonb_array_elements(CASE WHEN jsonb_typeof(value->'fileIds') = 'array' THEN value->'fileIds' ELSE '[]'::jsonb END) item
                    WHERE jsonb_typeof(item) = 'string'
            ) SELECT COALESCE(array_agg(DISTINCT id ORDER BY id), ARRAY[]::text[]) FROM ids WHERE id <> ''
            $$`);

        await queryRunner.query(`CREATE FUNCTION remote_file_cleanup_row_ids(document jsonb)
            RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
            SELECT remote_file_cleanup_json_ids(document) || ARRAY(
                SELECT document->>key FROM unnest(ARRAY['avatarId', 'bannerId', 'eyeCatchingImageId']) key
                WHERE jsonb_typeof(document->key) = 'string'
            ) $$`);

        // VOLATILE is intentional: after waiting for SHARE, the state SELECT
        // must obtain a new READ COMMITTED snapshot of the collector's commit.
        await queryRunner.query(`CREATE FUNCTION remote_file_cleanup_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
            DECLARE file_id text; old_ids text[] := ARRAY[]::text[];
            BEGIN
                IF TG_OP = 'UPDATE' THEN old_ids := remote_file_cleanup_row_ids(to_jsonb(OLD)); END IF;
                FOR file_id IN SELECT DISTINCT id FROM unnest(remote_file_cleanup_row_ids(to_jsonb(NEW))) id
                    WHERE NOT (id = ANY(old_ids)) ORDER BY id
                LOOP
                    PERFORM 1 FROM drive_file WHERE id = file_id FOR SHARE;
                    IF NOT FOUND THEN
                        RAISE EXCEPTION 'Drive file % no longer exists', file_id USING ERRCODE = '23503';
                    END IF;
                    IF EXISTS (SELECT 1 FROM remote_file_cleanup WHERE "fileId" = file_id AND state = 'deleting') THEN
                        RAISE EXCEPTION 'Drive file % is being removed', file_id USING ERRCODE = '23503';
                    END IF;
                END LOOP;
                RETURN NEW;
            END $$`);

        for (const [table, columns] of [
            ['note', '"fileIds"'],
            ['note_draft', '"fileIds"'],
            ['gallery_post', '"fileIds"'],
            ['user', '"avatarId", "bannerId"'],
            ['channel', '"bannerId"'],
            ['chat_message', '"fileId"'],
            ['page', '"eyeCatchingImageId", "content", "variables"'],
        ]) {
            await queryRunner.query(`CREATE TRIGGER remote_file_cleanup_reference_guard BEFORE INSERT OR UPDATE OF ${columns} ON "${table}"
                FOR EACH ROW EXECUTE FUNCTION remote_file_cleanup_guard()`);
        }
    }

    async down(queryRunner) {
        for (const table of ['note', 'note_draft', 'gallery_post', 'user', 'channel', 'chat_message', 'page']) {
            await queryRunner.query(`DROP TRIGGER remote_file_cleanup_reference_guard ON "${table}"`);
        }
        await queryRunner.query('DROP FUNCTION remote_file_cleanup_guard()');
        await queryRunner.query('DROP FUNCTION remote_file_cleanup_row_ids(jsonb)');
        await queryRunner.query('DROP FUNCTION remote_file_cleanup_json_ids(jsonb)');
    }
}
