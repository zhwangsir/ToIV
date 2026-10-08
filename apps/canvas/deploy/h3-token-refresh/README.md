# H3 credential refresh for canvas-api-pg (/studio)

## Why
`/studio` generates H3 video through the `toiv-h3` provider plugin. The plugin authenticates to
ToIV (`http://127.0.0.1:8090/api/h3/*`, which forwards to the H3 service on :8264) with a **scoped
service token** stored as the `apiKey` of the canvas-api channel(s) whose model profiles use protocol
`toiv-h3`. It is not a user's login JWT and not an admin JWT. The token is minted at
`POST http://127.0.0.1:8090/api/auth/service-token` with `scope=h3` for a non-admin account listed in
`TOIV_SERVICE_ACCOUNTS`. ToIV accepts it only on the H3 submit, `POST /api/upload?kind=h3_i2v`,
job lookup, cancel and image-download endpoints. `/api/auth/me`, job lists, `/api/h3/workers` and
`/api/h3/acceleration/profiles` answer 403. canvas-api never sends the token to a browser: model-config
reads through the ToIV login door return `__BEEFTV_REDACTED__`, and the server injects the stored
value into tasks (encrypted before the quote/create response).

The retired BeefTV gate used to overwrite the channel key with whoever had just logged in. That
stopped when the gate was retired, and the key then in prod was an admin session JWT expiring
**2026-10-13 13:29 (UTC+8)**. This script is the replacement, and it will not write a login JWT:
`TOKEN_MODE` is rejected, and `TOIV_API` must be exactly `http://127.0.0.1:8090` or the run exits
before the password is sent.

`h3_token_refresh.py` on a timer:
1. reads the credential canvas-api holds now (gate-signed internal identity) and logs its remaining validity;
2. mints a fresh h3-scoped service token and checks that `/api/auth/me` answers 403;
3. writes it into every `toiv-h3` channel (and, only if `SYNC_LLM_CHANNEL=1`, an llm-scoped token into `toiv-llm`), 409 → re-read, retry;
4. reads it back and checks it is the new one; logs the new expiry and the sha256 of whatever it replaced.

Failures are retried (`REFRESH_ATTEMPTS`, backoff 30 s / 60 s / 120 s; the ToIV login is done once
per run because `/api/auth/service-token` shares the login rate limit, 5/min per IP+account). Every failure logs a
`WARNING`; a final failure logs `ERROR … FAILED` and exits 1 (the unit shows `failed`). Validity
under `WARN_HOURS` (48) logs `WARNING H3 credential expires in … h` and exits 1. Tokens are never
logged — only an 8-hex sha256 fingerprint, the JWT subject prefix and the expiry. `STATUS_FILE`
keeps the last result as JSON for monitoring.

Two timers:
| unit | when | does |
|---|---|---|
| `toiv-h3-token-refresh.timer` | every 6 h (`00/6:17`, ±5 min, `Persistent=true`) | refresh |
| `toiv-h3-token-check.timer` | hourly | `--check` only (read-only), warns under 48 h |

A refresh every 6 h keeps the key at 162-168 h; 27 consecutive failed runs are needed before it
expires, and the hourly check starts warning about 5 days into such an outage.

## Service-account token (server-side only, H3-scoped)
The H3 channel key is no longer anybody's session JWT. It is a **scoped service token**:
- ToIV issues it at `POST /api/auth/service-token {email, password, scope:"h3"}` only to accounts
  listed in `TOIV_SERVICE_ACCOUNTS`, never to an admin. The token carries `scope:"h3"`; ToIV
  (`apps/api/app/token_policy.py`) accepts it only on `POST /api/h3/{t2v,i2v,fl2v,r2v}`,
  `POST /api/upload?kind=h3_i2v`, `GET /api/jobs/lookup`, `POST /api/jobs/{id}/cancel` and
  `GET /api/images`; everything else (incl. `/api/auth/me`, job lists, admin) answers 403.
  The script verifies both sides before storing it.
- canvas-api keeps it server-side: model-config reads through the ToIV login door (browsers via
  `/studio/api`) return `__BEEFTV_REDACTED__`; saving the config back preserves the stored value; the
  task admission injects the stored key for tasks whose channel matches (by id or base-URL origin) right
  before the task input is encrypted at rest. Only the gate-signed internal identity (this script)
  reads it back.
- All ToIV calls go to `TOIV_API=http://127.0.0.1:8090` only (outbound allowlist).

## Install on core (ToIV dev; not enabled by the M7 batch)
Files arrive on core with `deploy.sh --with-canvas/--canvas-only` under
`/home/merlin/toiv/apps/canvas/deploy/h3-token-refresh/`.

```bash
# 0. ToIV API (deploy the branch first): service accounts + revocation list, in the toiv-api env
#    TOIV_SERVICE_ACCOUNTS=svc_canvas_h3
#    TOIV_SERVICE_TOKEN_EXPIRE_MINUTES=10080
#    TOIV_REVOKED_TOKENS_FILE=/home/merlin/beeftv-prod/secrets/toiv_revoked_tokens.json
#    then create the account (non-admin, no other use) in the admin console, e.g. svc_canvas_h3.

# 1. service account credentials for the script (0600)
install -d -m 700 /home/merlin/beeftv-prod/h3-token-refresh
umask 077
cat > /home/merlin/beeftv-prod/secrets/h3_service_account.env <<'CRED'
TOIV_H3_EMAIL=svc_canvas_h3
TOIV_H3_PASSWORD=<service account password>
CRED
chmod 600 /home/merlin/beeftv-prod/secrets/h3_service_account.env   # the script refuses 0644

# 2. script + config
D=/home/merlin/toiv/apps/canvas/deploy/h3-token-refresh
install -m 700 $D/h3_token_refresh.py /home/merlin/beeftv-prod/h3-token-refresh/
install -m 600 $D/h3-token-refresh.env.example /home/merlin/beeftv-prod/h3-token-refresh/h3-token-refresh.env

# 3. one manual run first (read-only check, dry-run mint, then the real refresh)
cd /home/merlin/beeftv-prod/h3-token-refresh
python3 h3_token_refresh.py --env h3-token-refresh.env --check
python3 h3_token_refresh.py --env h3-token-refresh.env --dry-run
python3 h3_token_refresh.py --env h3-token-refresh.env   # expect "refreshed: … scope=h3 … retiredRecorded=1"

# 4. timers (merlin has Linger=yes, so user timers run without a login session)
install -m 644 $D/toiv-h3-token-*.service $D/toiv-h3-token-*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now toiv-h3-token-refresh.timer toiv-h3-token-check.timer
systemctl --user list-timers 'toiv-h3-token-*'
```

## Revoking the old admin JWT
The first service-mode run records the sha256 of the replaced credential (today: an admin session
JWT, subject `f659936d…`) in `RETIRED_FILE`. Revoke exactly that token (other admin sessions stay
logged in); ToIV re-reads the list on change, no restart:
```bash
cd /home/merlin/toiv/apps/api
python3 scripts/revoke_token.py --file /home/merlin/beeftv-prod/secrets/toiv_revoked_tokens.json \
    --sha256 $(cat /home/merlin/beeftv-prod/h3-token-refresh/retired.sha256)
python3 scripts/revoke_token.py --file /home/merlin/beeftv-prod/secrets/toiv_revoked_tokens.json --list
```
Do this only after the H3 channel holds the service token (`status.json`: `after.scope == "h3"`) and
a /studio H3 job succeeded, otherwise /studio H3 breaks. The gate copied the admin's *login* JWT,
so if that browser session is still in use it is logged out once (log in again). Heavier options:
`--user <admin uid>` (all admin tokens issued before now) or rotating `TOIV_JWT_SECRET` (everyone).

Operate:
```bash
systemctl --user start toiv-h3-token-refresh.service      # refresh now
tail -n 20 /home/merlin/beeftv-prod/h3-token-refresh/{refresh,check}.log
cat /home/merlin/beeftv-prod/h3-token-refresh/status.json
grep -E 'WARNING|ERROR' /home/merlin/beeftv-prod/h3-token-refresh/*.log | tail
```
Uninstall: `systemctl --user disable --now toiv-h3-token-refresh.timer toiv-h3-token-check.timer`,
remove the four unit files, `daemon-reload`.

No restart of canvas-api-pg is needed for the key itself (read per request from the model config);
the redaction/injection code ships with the canvas-api build of this branch.

## Decisions for ToIV dev
1. **Which account** signs H3 jobs: the dedicated service account (non-admin, H3-scoped token). H3
   jobs/credits in ToIV are then owned by it, not by the person using /studio (canvas-api keeps
   per-user ownership of its own tasks/assets).
2. **Alerting.** Warnings go to the log files and `status.json`. Hook them into whatever alerting
   exists (e.g. `OnFailure=` to a notifier unit) if a push notification is wanted.
3. After multi-tenancy (`feat/canvas-multitenant`) the H3 key is a platform credential that users can
   neither read nor edit; this script keeps writing it through the same internal identity.

## Tests
`python3 -m unittest -v test_h3_token_refresh.py` — offline, fake ToIV + fake canvas-api on loopback:
stores only a scoped `h3` token (refuses a token ToIV does not scope-limit), `llm`-scoped token for
toiv-llm only when enabled, `TOKEN_MODE` and any TOIV_API other than http://127.0.0.1:8090 are refused
before the password is sent, any CANVAS_API other than http://127.0.0.1:8290 is refused before the token is sent, replaced credentials recorded as sha256
only (0600), leaves other channels alone, 409 retry, mint failure → 3
attempts + ERROR + 48 h warning + exit 1, canvas failure → retries without re-login, `--check` is
read-only and warns under the threshold, wrong identity key → 401, readable credential file → exit 2,
and no token ever appears in the output.
