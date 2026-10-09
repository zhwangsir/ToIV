# ToIV staging deployment (core)

- `beeftv-web` (0.0.0.0:8271) runs `gate/serve.mjs`: ToIV login gate + static SPA + per-user API proxy.
- `beeftv-user@<toiv_user_id>` (127.0.0.1:83xx) is one BeefTV backend per ToIV user, data in
  `/home/merlin/beeftv-staging/users/<uid>/data` (spawned on demand after login, reclaimed when idle; see web.env.example).
- `beeftv-backend` (127.0.0.1:8272) is the legacy shared instance; it is no longer routed by the gate.
- Copy `gate/model-config.template.json` (or `*.example.json` → strip `.example`) to `/home/merlin/beeftv-staging/gate/` and `/home/merlin/beeftv-prod/gate/`;
  keep live matched to example (H3 int8_convrot + Qwen-Rapid-AIO-SFW-v11 + deepseek-v4-flash-dspark); secrets live only in `/home/merlin/beeftv-staging/secrets/` (0700).

## Login / startup screens (M4)
`gate/login.html` and `gate/starting.html` share `gate/gate-style.html` and load the SPA stylesheets
(`index-*.css` fonts, `application-*.css` tokens) so they only use BeefTV tokens (`--user-*`, Inter);
the primary button copies the home 「新建画布创作」 button. Unauthenticated: `/static/*` and the logo are public.

## On-demand instances (M4)
Login (or any authenticated hit) spawns the user backend if a slot is free (`GATE_MAX_INSTANCES`), otherwise
the user waits in a FIFO queue on `/__toiv/starting`. Ports come from the `USER_PORT_BASE..USER_PORT_MAX`
pool and are released on reclaim; `users/<uid>/data` persists. Idle instances (`GATE_IDLE_MS`, no queued or
running task in `/api/tasks`) are stopped. Crashes are respawned by systemd (`Restart=always`) and by the gate
health monitor. Instances still running when the gate restarts are adopted.
