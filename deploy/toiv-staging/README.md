# ToIV staging deployment (core)

- `beeftv-web` (0.0.0.0:8271) runs `gate/serve.mjs`: ToIV login gate + static SPA + per-user API proxy.
- `beeftv-user@<toiv_user_id>` (127.0.0.1:83xx) is one BeefTV backend per ToIV user, data in
  `/home/merlin/beeftv-staging/users/<uid>/data` (started by the gate on login / gate start).
- `beeftv-backend` (127.0.0.1:8272) is the legacy shared instance; it is no longer routed by the gate.
- Copy `gate/*.example.json` to `/home/merlin/beeftv-staging/gate/` without the `.example` suffix and
  fill the H3 channel from the template; secrets live only in `/home/merlin/beeftv-staging/secrets/` (0700).
