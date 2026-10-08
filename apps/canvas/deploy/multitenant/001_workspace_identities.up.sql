-- M7 multi-tenant: bind the platform admin's ToIV id to the pre-existing shared workspace.
-- psql variables: admin_uid (ToIV user id of the platform admin), legacy_ws (the existing
-- workspaces.id; default: the oldest workspace). Run inside the canvas schema
-- (search_path), BEFORE canvas-api starts with CANVAS_USER_IDENTITY_KEY_FILE.
-- Reversible: 001_workspace_identities.down.sql. No row outside workspace_identities changes.
BEGIN;

CREATE TABLE IF NOT EXISTS workspace_identities (
    subject      varchar(64) PRIMARY KEY,
    workspace_id varchar(36) NOT NULL,
    source       varchar(32) NOT NULL DEFAULT 'toiv',
    created_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_identities_workspace ON workspace_identities (workspace_id);

-- Remember what (if anything) the admin was bound to before, so down can restore it.
CREATE TABLE IF NOT EXISTS workspace_identity_migrations (
    id                    bigserial PRIMARY KEY,
    migration             varchar(64) NOT NULL,
    subject               varchar(64) NOT NULL,
    workspace_id          varchar(36) NOT NULL,
    previous_workspace_id varchar(36),
    applied_at            timestamptz NOT NULL DEFAULT now()
);

-- psql does not interpolate variables inside dollar quotes: pass them as transaction settings.
SELECT set_config('m7.admin_uid', :'admin_uid', true), set_config('m7.legacy_ws', :'legacy_ws', true) \gset m7_

DO $$
DECLARE
    v_admin  text := current_setting('m7.admin_uid');
    v_legacy text := NULLIF(current_setting('m7.legacy_ws'), '');
    v_prev   text;
BEGIN
    IF v_admin !~ '^[A-Za-z0-9_-]{1,36}$' THEN
        RAISE EXCEPTION 'admin_uid invalid';
    END IF;
    IF v_legacy IS NULL THEN
        SELECT id INTO v_legacy FROM workspaces ORDER BY created_at ASC LIMIT 1;
    END IF;
    IF v_legacy IS NULL OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = v_legacy) THEN
        RAISE EXCEPTION 'legacy workspace not found';
    END IF;
    SELECT workspace_id INTO v_prev FROM workspace_identities WHERE subject = v_admin;
    IF v_prev = v_legacy THEN
        RAISE NOTICE 'already applied: admin is bound to the legacy workspace';
        RETURN;
    END IF;
    IF v_prev IS NOT NULL AND v_prev <> v_legacy AND EXISTS (SELECT 1 FROM canvas_projects WHERE user_id = v_prev) THEN
        RAISE EXCEPTION 'admin already bound to a non-empty workspace %, refusing to rebind', v_prev;
    END IF;
    -- Another subject must not already own the legacy workspace.
    IF EXISTS (SELECT 1 FROM workspace_identities WHERE workspace_id = v_legacy AND subject <> v_admin) THEN
        RAISE EXCEPTION 'legacy workspace already bound to another subject';
    END IF;
    INSERT INTO workspace_identities (subject, workspace_id, source, created_at)
    VALUES (v_admin, v_legacy, 'm7-legacy-admin', now())
    ON CONFLICT (subject) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, source = EXCLUDED.source;
    INSERT INTO workspace_identity_migrations (migration, subject, workspace_id, previous_workspace_id)
    VALUES ('001_workspace_identities', v_admin, v_legacy, v_prev);
END $$;

COMMIT;
