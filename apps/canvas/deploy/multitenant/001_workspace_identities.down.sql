-- Reverts 001: removes the admin -> legacy workspace binding (restoring a previous binding if
-- the up migration replaced one). Tenant workspaces and their rows are NOT deleted: they stay
-- owned by their own workspace ids and are simply unreachable from the single-workspace binary.
-- Optional full cleanup (only after rolling the binary back): psql -v drop_tables=1.
BEGIN;
DO $$
DECLARE
    rec record;
BEGIN
    FOR rec IN SELECT * FROM workspace_identity_migrations WHERE migration = '001_workspace_identities' ORDER BY id DESC LIMIT 1 LOOP
        IF rec.previous_workspace_id IS NULL THEN
            DELETE FROM workspace_identities WHERE subject = rec.subject AND workspace_id = rec.workspace_id;
        ELSE
            UPDATE workspace_identities SET workspace_id = rec.previous_workspace_id, source = 'toiv' WHERE subject = rec.subject AND workspace_id = rec.workspace_id;
        END IF;
        DELETE FROM workspace_identity_migrations WHERE id = rec.id;
    END LOOP;
END $$;
COMMIT;
\if :{?drop_tables}
DROP TABLE IF EXISTS workspace_identity_migrations;
DROP TABLE IF EXISTS workspace_identities;
\endif
