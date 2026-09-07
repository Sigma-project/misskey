/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RemoteFileReferenceGuard1788783564794 {
    name = 'RemoteFileReferenceGuard1788783564794';

    async up(queryRunner) {
        // Page content and variables may contain other users' files. Use the same
        // extractor in the collector and writer guard, including nested blocks.
        // IMPORTANT: IDX_PAGE_REMOTE_FILE_REFERENCES stores results of this
        // IMMUTABLE function. Any future extraction change MUST rebuild that
        // index in the same migration before collection resumes; PostgreSQL
        // does not invalidate expression-index entries after function changes.
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

        // VOLATILE is intentional: after waiting for SHARE, the state SELECT
        // must obtain a new READ COMMITTED snapshot of the collector's commit.
        await queryRunner.query(`CREATE FUNCTION remote_file_cleanup_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
            DECLARE file_id text; new_ids text[]; old_ids text[] := ARRAY[]::text[];
            BEGIN
                -- Never serialize the whole row: Note text/reactions and other
                -- unrelated JSON are not references. Only Pages need recursion.
                CASE TG_ARGV[0]
                    WHEN 'array' THEN
                        new_ids := NEW."fileIds"::text[];
                        IF TG_OP = 'UPDATE' THEN old_ids := OLD."fileIds"::text[]; END IF;
                    WHEN 'user' THEN
                        new_ids := ARRAY[NEW."avatarId", NEW."bannerId"]::text[];
                        IF TG_OP = 'UPDATE' THEN old_ids := ARRAY[OLD."avatarId", OLD."bannerId"]::text[]; END IF;
                    WHEN 'channel' THEN
                        new_ids := ARRAY[NEW."bannerId"]::text[];
                        IF TG_OP = 'UPDATE' THEN old_ids := ARRAY[OLD."bannerId"]::text[]; END IF;
                    WHEN 'chat' THEN
                        new_ids := ARRAY[NEW."fileId"]::text[];
                        IF TG_OP = 'UPDATE' THEN old_ids := ARRAY[OLD."fileId"]::text[]; END IF;
                    WHEN 'page' THEN
                        new_ids := remote_file_cleanup_json_ids(NEW.content) || remote_file_cleanup_json_ids(NEW.variables) || ARRAY[NEW."eyeCatchingImageId"]::text[];
                        IF TG_OP = 'UPDATE' THEN
                            old_ids := remote_file_cleanup_json_ids(OLD.content) || remote_file_cleanup_json_ids(OLD.variables) || ARRAY[OLD."eyeCatchingImageId"]::text[];
                        END IF;
                END CASE;
                old_ids := COALESCE(array_remove(old_ids, NULL), ARRAY[]::text[]);
                FOR file_id IN SELECT DISTINCT id FROM unnest(new_ids) id
                    WHERE id IS NOT NULL AND NOT (id = ANY(old_ids)) ORDER BY id
                LOOP
                    PERFORM 1 FROM drive_file WHERE id = file_id FOR SHARE;
                    IF NOT FOUND THEN
                        RAISE EXCEPTION 'Drive file % no longer exists', file_id USING ERRCODE = '23503', CONSTRAINT = 'remote_file_cleanup_reference_guard';
                    END IF;
                    IF EXISTS (SELECT 1 FROM remote_file_cleanup WHERE "fileId" = file_id AND state = 'deleting') THEN
                        RAISE EXCEPTION 'Drive file % is being removed', file_id USING ERRCODE = '23503', CONSTRAINT = 'remote_file_cleanup_reference_guard';
                    END IF;
                END LOOP;
                RETURN NEW;
            END $$`);

        for (const [table, columns, kind, nonempty] of [
            ['note', ['fileIds'], 'array', 'cardinality(NEW."fileIds") > 0'],
            ['note_draft', ['fileIds'], 'array', 'cardinality(NEW."fileIds") > 0'],
            ['gallery_post', ['fileIds'], 'array', 'cardinality(NEW."fileIds") > 0'],
            ['user', ['avatarId', 'bannerId'], 'user', 'NEW."avatarId" IS NOT NULL OR NEW."bannerId" IS NOT NULL'],
            ['channel', ['bannerId'], 'channel', 'NEW."bannerId" IS NOT NULL'],
            ['chat_message', ['fileId'], 'chat', 'NEW."fileId" IS NOT NULL'],
            ['page', ['eyeCatchingImageId', 'content', 'variables'], 'page', `NEW."eyeCatchingImageId" IS NOT NULL OR NEW.content <> '[]'::jsonb OR NEW.variables <> '[]'::jsonb`],
        ]) {
            await queryRunner.query(`CREATE TRIGGER remote_file_cleanup_reference_guard BEFORE INSERT ON "${table}"
                FOR EACH ROW WHEN (${nonempty}) EXECUTE FUNCTION remote_file_cleanup_guard('${kind}')`);
            const changed = columns.map(column => `OLD."${column}" IS DISTINCT FROM NEW."${column}"`).join(' OR ');
            await queryRunner.query(`CREATE TRIGGER remote_file_cleanup_reference_update_guard BEFORE UPDATE OF ${columns.map(column => `"${column}"`).join(', ')} ON "${table}"
                FOR EACH ROW WHEN ((${nonempty}) AND (${changed})) EXECUTE FUNCTION remote_file_cleanup_guard('${kind}')`);
        }
    }

    async down(queryRunner) {
        for (const table of ['note', 'note_draft', 'gallery_post', 'user', 'channel', 'chat_message', 'page']) {
            await queryRunner.query(`DROP TRIGGER remote_file_cleanup_reference_guard ON "${table}"`);
            await queryRunner.query(`DROP TRIGGER IF EXISTS remote_file_cleanup_reference_update_guard ON "${table}"`);
        }
        await queryRunner.query('DROP FUNCTION remote_file_cleanup_guard()');
        await queryRunner.query('DROP FUNCTION IF EXISTS remote_file_cleanup_row_ids(jsonb)');
        // Revert PageRemoteFileReferencesIndex first. Do not use CASCADE here:
        // dependency failure must expose an incorrect rollback order.
        await queryRunner.query('DROP FUNCTION remote_file_cleanup_json_ids(jsonb)');
    }
}
