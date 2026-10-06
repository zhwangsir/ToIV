# CHANGELOG-TOIV

ToIV-canvas is a private ToIV integration of [BeefTV](https://github.com/glanderness/BeefTV) (MIT).
Base: upstream `main` @ `f083b50` (fix: 参考素材渠道预检、链接填写及视频开关参数修复 #82).
The upstream MIT license and copyright lines stay as they are. Remotes: `upstream` = glanderness/BeefTV,
`origin`/`github` = zhwangsir/ToIV-canvas (private), `gitee` = Gitee mirror (private).

## Patches on top of upstream

### Backend
- **Declarative provider cancel** (`internal/app/provider_task_cancellation.go`): installed declarative plugins
  that declare a `cancel` operation get upstream cancel propagation (requested → confirmed / uncertain).
- **Agent op store** (`internal/operations/store.go`): pre-checks existing op records before insert; removes
  the `UNIQUE constraint failed` log spam on op replays.
- **Appearance defaults** (`internal/appearance`): ToIV brand name, `DefaultLogoURL=/logo.svg`.
- **Diagnostics** (`internal/diagnostics/ports.go`): staging port awareness.
- **Poll fallback + authoritative resume key** (M3b):
  - `ManifestOperation.fallback` (poll only) + `RequestSpec.Fallback`: when the primary poll is rejected
    with HTTP 400/422, the fallback request is tried once and preferred for the rest of that poll loop.
  - The declarative poll/cancel call carries the adapter's own `taskId` as provider request id, and the
    API-call-log enrichment no longer replaces it with a scraped generic `id` for `poll`/`cancel` logs.
    This makes the persisted `providerRequestId` the real resume key (it used to become ToIV's job id,
    so `lookup?prompt_id=<job id>` 404-ed after a backend restart).

### Plugin `plugin-packages/toiv-h3` (v0.2.0)
- ToIV H3 text-to-video via ToIV `/api/h3/t2v` with the user's own ToIV JWT (Bearer).
- Task key = `<job_id>~<prompt_id>` once the first lookup returned the job id (`prompt_id` before that).
- Poll: `GET /api/jobs/lookup?job_id=<job_id>` (ToIV main 08554934); fallback
  `?prompt_id=<prompt_id>` when the deployed API answers 422 (older deploys require `prompt_id`).
- Cancel: `POST /api/jobs/<job_id>/cancel` (ToIV accepts job id or prompt id).

### Web
- ToIV branding: `logo.svg`, `favicon.svg`, `toiv-logo.svg`, `toiv-mark.svg`, title, CSS masks, sidebar/top-bar
  fallback letter `T`, visible product strings.
- Neutral **已取消** state (M3b): cancelled tasks are grey/neutral instead of the red 「失败」 style
  (canvas node badge + node body, batch table rows, script batch tone, task list row/grid card).

### Deploy (`deploy/toiv-staging/`)
- `serve.mjs` login gate: ToIV account login (`POST /api/auth/login`), HttpOnly SameSite=Strict session
  cookie validated against ToIV `/api/auth/me`; one BeefTV backend per ToIV user
  (`beeftv-user@<uid>.service`, own port + data dir) so canvases/tasks/assets/assistant data are isolated;
  the user's ToIV JWT is written into their own ToIV H3 channel. The owner token of each instance stays on
  the server and is attached only to that authenticated user's proxied calls.
- Removed the loopback-only `BEEFTV_UI_BOOTSTRAP=1` and the unauthenticated loopback owner injection.
- systemd user units, build scripts and helper scripts (they read secrets from files that are never committed).
