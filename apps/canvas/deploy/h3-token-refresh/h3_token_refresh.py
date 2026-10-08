#!/usr/bin/env python3
"""Keep the platform H3 credential in canvas-api fresh (ToIV JWT, 7-day lifetime).

Why: the retired BeefTV gate (serve.mjs syncChannelToken) wrote the logged-in user's ToIV JWT into
the canvas-api channels whose model profiles use protocol "toiv-h3" (and the "toiv-llm" channel)
on every login, via GET/PUT /api/workspace/model-config signed with the gate identity header.
Since the gate retired nothing writes it, so H3 in /studio starts returning 401 once that JWT
expires. This script does the same write on a timer, with a dedicated SERVICE ACCOUNT whose token
is scope-limited by ToIV to the H3 endpoints (POST /api/auth/service-token, scope "h3"): it is not
an admin JWT, it cannot call any other ToIV API, and canvas-api keeps it server-side (browsers only
ever see the redaction marker; the server injects it into H3 tasks).

Steps per run:
  1. Read the H3 credential that canvas-api currently holds and report its remaining validity.
  2. POST {TOIV_API}/api/auth/service-token {scope: h3} with the service account -> scoped JWT;
     verify it: an H3 endpoint accepts it and /api/auth/me refuses it (403 = scope enforced).
     (TOKEN_MODE=login keeps the legacy full-login token for a ToIV without the endpoint; it warns.)
  3. GET model-config, set apiKey on every toiv-h3 channel (and toiv-llm with an "llm"-scoped
     token when SYNC_LLM_CHANNEL=1), PUT it back with expectedRevision (409 -> re-read and retry).
  4. Read back and verify the stored credential is the new one; report the new expiry.
  5. RETIRED_FILE (optional): append the sha256 of every credential this run replaced, for
     apps/api/scripts/revoke_token.py --sha256 (revokes e.g. the old admin JWT; no token is written).
  Steps 2-4 are retried (REFRESH_ATTEMPTS, exponential backoff); the login itself happens once per
  run once it has succeeded, because ToIV rate-limits /api/auth/login (HTTP 429). Remaining validity under
  WARN_HOURS (default 48) logs a WARNING and makes the run exit non-zero.

Never prints a token: only an 8-hex sha256 fingerprint, the JWT subject prefix and the expiry.
Modes: (default) refresh | --check (read-only: report + warn) | --dry-run (login, no write).
Exit codes: 0 ok, 1 refresh failed or validity below the warning threshold, 2 bad configuration.

Configuration (environment, usually from an EnvironmentFile; see README.md):
  TOIV_API             default http://127.0.0.1:8090 (the only ToIV address used; outbound allowlist)
  TOKEN_MODE           service (default: scoped service token) | login (legacy, warns)
  CANVAS_API           default http://127.0.0.1:8290
  CANVAS_ENV_FILE      canvas-api EnvironmentFile; BEEFTV_GATE_UID / BEEFTV_GATE_KEY_FILE are read
                       from it unless CANVAS_GATE_UID / CANVAS_GATE_KEY_FILE are set
  H3_CRED_FILE         0600 file with TOIV_H3_EMAIL=... and TOIV_H3_PASSWORD=... (service account)
  SYNC_LLM_CHANNEL     0 (default) leave the "toiv-llm" channel alone; 1 also refresh it (llm-scoped token)
  RETIRED_FILE         optional 0600 file collecting sha256 fingerprints of replaced credentials
  WARN_HOURS           default 48
  REFRESH_ATTEMPTS     default 4;  RETRY_BASE_SECONDS default 30 (30, 60, 120 ...)
  STATUS_FILE          optional JSON status file for monitoring (no secrets)
"""
import base64, hashlib, hmac, json, os, stat, sys, time, urllib.error, urllib.request

H3_PROTOCOLS = {"toiv-h3"}
H3_MODELS = {"h3-t2v", "h3", "h3-i2v", "h3-fl2v", "h3-r2v"}


def log(level, msg):
    stream = sys.stderr if level in ("WARNING", "ERROR") else sys.stdout
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {level} {msg}", file=stream, flush=True)


class ConfigError(Exception):
    pass


def read_env_file(path):
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def fingerprint(token):
    return hashlib.sha256(token.encode()).hexdigest()[:8] if token else "-"


def jwt_claims(token):
    """Decode (not verify) a JWT payload; ToIV verifies it, we only need sub/exp for reporting."""
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except Exception:
        return {}


def describe(token):
    c = jwt_claims(token)
    exp = c.get("exp")
    if not isinstance(exp, (int, float)):
        return {"fingerprint": fingerprint(token), "sub": str(c.get("sub", ""))[:8], "exp": None, "hoursLeft": None}
    return {"fingerprint": fingerprint(token), "sub": str(c.get("sub", ""))[:8],
            "exp": time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(exp)),
            "hoursLeft": round((exp - time.time()) / 3600, 1)}


class Settings:
    def __init__(self, env):
        self.toiv = env.get("TOIV_API", "http://127.0.0.1:8090").rstrip("/")
        self.canvas = env.get("CANVAS_API", "http://127.0.0.1:8290").rstrip("/")
        self.sync_llm = env.get("SYNC_LLM_CHANNEL", "0") == "1"
        self.token_mode = env.get("TOKEN_MODE", "service").strip().lower()
        if self.token_mode not in ("service", "login"):
            raise ConfigError("TOKEN_MODE must be service or login")
        self.retired_file = env.get("RETIRED_FILE", "")
        self.warn_hours = float(env.get("WARN_HOURS", "48"))
        self.attempts = max(1, int(env.get("REFRESH_ATTEMPTS", "4")))
        self.retry_base = max(0.0, float(env.get("RETRY_BASE_SECONDS", "30")))
        self.status_file = env.get("STATUS_FILE", "")
        canvas_env = {}
        if env.get("CANVAS_ENV_FILE"):
            canvas_env = read_env_file(env["CANVAS_ENV_FILE"])
        self.gate_uid = env.get("CANVAS_GATE_UID") or canvas_env.get("BEEFTV_GATE_UID", "")
        key_file = env.get("CANVAS_GATE_KEY_FILE") or canvas_env.get("BEEFTV_GATE_KEY_FILE", "")
        if not self.gate_uid or not key_file:
            raise ConfigError("canvas-api identity missing: set CANVAS_ENV_FILE or CANVAS_GATE_UID + CANVAS_GATE_KEY_FILE")
        with open(key_file, "rb") as fh:
            self.gate_key = fh.read().strip()
        if len(self.gate_key) < 32:
            raise ConfigError("canvas-api gate key file is too short")
        self.cred_file = env.get("H3_CRED_FILE", "")

    def credentials(self):
        if not self.cred_file:
            raise ConfigError("H3_CRED_FILE is not set")
        mode = stat.S_IMODE(os.stat(self.cred_file).st_mode)
        if mode & 0o077:
            raise ConfigError(f"H3_CRED_FILE must not be group/world readable (mode {oct(mode)})")
        c = read_env_file(self.cred_file)
        if not c.get("TOIV_H3_EMAIL") or not c.get("TOIV_H3_PASSWORD"):
            raise ConfigError("H3_CRED_FILE needs TOIV_H3_EMAIL and TOIV_H3_PASSWORD")
        return c["TOIV_H3_EMAIL"], c["TOIV_H3_PASSWORD"]


def http_json(method, url, body=None, headers=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    h = {"accept": "application/json", **(headers or {})}
    if data is not None:
        h["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    try:
        return status, json.loads(raw or b"null")
    except ValueError:
        return status, None


class Canvas:
    """canvas-api client authenticated with the internal gate identity (X-Beeftv-Gate-Auth)."""
    def __init__(self, s):
        self.s = s

    def _auth(self, method, path):
        ts = int(time.time())
        msg = f"v1\n{self.s.gate_uid}\n{ts}\n{method}\n{path.split('?')[0]}".encode()
        sig = hmac.new(self.s.gate_key, msg, hashlib.sha256).hexdigest()
        return {"x-beeftv-gate-auth": f"v1.{self.s.gate_uid}.{ts}.{sig}"}

    def get_config(self):
        p = "/api/workspace/model-config"
        status, j = http_json("GET", self.s.canvas + p, headers=self._auth("GET", p))
        if status != 200 or not isinstance(j, dict) or not isinstance((j.get("data") or {}).get("config"), dict):
            raise RuntimeError(f"GET model-config failed (HTTP {status})")
        return j["data"]["config"], j["data"].get("revision")

    def put_config(self, config, revision):
        p = "/api/workspace/model-config"
        body = {"config": config}
        if revision is not None:
            body["expectedRevision"] = revision
        status, j = http_json("PUT", self.s.canvas + p, body=body, headers=self._auth("PUT", p), timeout=30)
        return status, (j or {}).get("data") if isinstance(j, dict) else None


def is_h3_channel(ch):
    for p in ch.get("modelProfiles") or []:
        if p.get("protocol") in H3_PROTOCOLS or p.get("model") in H3_MODELS:
            return True
    return ch.get("pluginId") == "toiv-h3" or ch.get("providerId") == "toiv-h3"


def target_channels(config, sync_llm):
    chans = config.get("channels") or []
    h3 = [c for c in chans if isinstance(c, dict) and is_h3_channel(c)]
    llm = [c for c in chans if isinstance(c, dict) and c.get("id") == "toiv-llm"] if sync_llm else []
    return h3, llm


def current_credential(canvas, sync_llm):
    config, revision = canvas.get_config()
    h3, _ = target_channels(config, sync_llm)
    if not h3:
        raise RuntimeError("no toiv-h3 channel in canvas-api model-config")
    keys = {c.get("apiKey") or "" for c in h3}
    if len(keys) > 1:
        log("WARNING", f"toiv-h3 channels hold {len(keys)} different credentials")
    token = sorted(keys, key=lambda t: (jwt_claims(t).get("exp") or 0))[0]  # the soonest to expire
    if token and "*" in token:
        log("WARNING", "canvas-api returned a redacted credential; expiry cannot be read back")
    return token, [c.get("id") for c in h3], revision


def _token_from(status, j, what):
    token = (j or {}).get("token") if isinstance(j, dict) else None
    if status != 200 or not token:
        raise RuntimeError(f"ToIV {what} failed (HTTP {status})")
    return token


def mint_service_token(s, scope):
    """Scoped service token: only the endpoints of `scope` accept it (ToIV app/token_policy.py)."""
    email, password = s.credentials()
    status, j = http_json("POST", s.toiv + "/api/auth/service-token",
                          body={"email": email, "password": password, "scope": scope})
    token = _token_from(status, j, f"service-token ({scope})")
    if (j or {}).get("scope") != scope or jwt_claims(token).get("scope") != scope:
        raise RuntimeError(f"ToIV returned a token without scope {scope}")
    return token


def verify_scoped(s, token, scope):
    """The token must work on its scope and be refused elsewhere (proves least privilege)."""
    auth = {"authorization": "Bearer " + token}
    probe = "/api/jobs/lookup?job_id=h3-token-refresh-probe" if scope == "h3" else "/api/llm/v1/models"
    status, _ = http_json("GET", s.toiv + probe, headers=auth)
    if status in (401, 403):
        raise RuntimeError(f"fresh {scope} token rejected by its own scope (HTTP {status})")
    status, _ = http_json("GET", s.toiv + "/api/auth/me", headers=auth)
    if status != 403:
        raise RuntimeError(f"fresh {scope} token is not scope-limited (/api/auth/me HTTP {status}, want 403)")


def login(s):
    """Fresh credentials for this run: {"h3": token, "llm": token?}."""
    if s.token_mode == "login":
        log("WARNING", "TOKEN_MODE=login: storing a full (unscoped) ToIV session token; switch to TOKEN_MODE=service")
        email, password = s.credentials()
        status, j = http_json("POST", s.toiv + "/api/auth/login", body={"email": email, "password": password})
        token = _token_from(status, j, "login")
        status, _ = http_json("GET", s.toiv + "/api/auth/me", headers={"authorization": "Bearer " + token})
        if status != 200:
            raise RuntimeError(f"fresh token rejected by /api/auth/me (HTTP {status})")
        return {"h3": token, "llm": token}
    tokens = {"h3": mint_service_token(s, "h3")}
    verify_scoped(s, tokens["h3"], "h3")
    if s.sync_llm:
        tokens["llm"] = mint_service_token(s, "llm")
        verify_scoped(s, tokens["llm"], "llm")
    return tokens


def record_retired(s, tokens):
    """Append sha256 fingerprints of replaced credentials (never the tokens) to RETIRED_FILE."""
    if not s.retired_file:
        return 0
    hashes = sorted({hashlib.sha256(t.encode()).hexdigest() for t in tokens if t and "*" not in t and t != "__BEEFTV_REDACTED__"})
    if not hashes:
        return 0
    try:
        with open(s.retired_file, encoding="utf-8") as fh:
            known = {line.strip() for line in fh}
    except FileNotFoundError:
        known = set()
    fresh = [h for h in hashes if h not in known]
    if fresh:
        fd = os.open(s.retired_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write("".join(h + "\n" for h in fresh))
    return len(fresh)


def write_token(canvas, tokens, sync_llm):
    """Returns (h3 ids, llm ids, revision, replaced credentials)."""
    for attempt in range(3):  # 409 = someone saved the config meanwhile: re-read and re-apply
        config, revision = canvas.get_config()
        h3, llm = target_channels(config, sync_llm)
        if not h3:
            raise RuntimeError("no toiv-h3 channel in canvas-api model-config")
        replaced = set()
        for c in h3:
            replaced.add(c.get("apiKey") or "")
            c["apiKey"] = tokens["h3"]
        for c in llm:
            replaced.add(c.get("apiKey") or "")
            c["apiKey"] = tokens.get("llm") or tokens["h3"]
        status, data = canvas.put_config(config, revision)
        if status == 200:
            replaced -= set(tokens.values())
            return [c.get("id") for c in h3], [c.get("id") for c in llm], (data or {}).get("revision"), replaced
        if status != 409:
            raise RuntimeError(f"PUT model-config failed (HTTP {status})")
        log("INFO", "model-config revision conflict, re-reading")
    raise RuntimeError("PUT model-config kept conflicting")


def write_status(s, status):
    if not s.status_file:
        return
    tmp = s.status_file + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
        json.dump(status, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, s.status_file)


def main(argv):
    mode = "check" if "--check" in argv else "dry-run" if "--dry-run" in argv else "refresh"
    try:
        env = {}
        if "--env" in argv:  # file = defaults; the process environment (systemd, shell) wins
            env.update(read_env_file(argv[argv.index("--env") + 1]))
        env.update(os.environ)
        s = Settings(env)
        if mode != "check":
            s.credentials()
    except (ConfigError, OSError, ValueError, IndexError) as e:
        log("ERROR", f"configuration: {e}")
        return 2
    canvas = Canvas(s)
    status = {"mode": mode, "at": time.strftime("%Y-%m-%d %H:%M:%S %z"), "canvas": s.canvas, "ok": False}

    before = None
    try:
        tok, ids, rev = current_credential(canvas, s.sync_llm)
        before = describe(tok)
        before["scope"] = jwt_claims(tok).get("scope")
        status["before"] = before
        log("INFO", f"current H3 credential: channels={ids} revision={rev} fp={before['fingerprint']} "
                    f"sub={before['sub']} scope={before['scope']} exp={before['exp']} hoursLeft={before['hoursLeft']}")
    except Exception as e:  # keep going: a refresh can still repair it
        log("WARNING", f"cannot read current H3 credential: {e}")

    if mode == "check":
        left = (before or {}).get("hoursLeft")
        status["ok"] = left is not None and left >= s.warn_hours
        if left is None:
            log("WARNING", "H3 credential validity unknown")
        elif left < s.warn_hours:
            log("WARNING", f"H3 credential expires in {left} h (< {s.warn_hours:g} h): run the refresh now")
        write_status(s, status)
        return 0 if status["ok"] else 1

    last_err, tokens = None, None
    for attempt in range(1, s.attempts + 1):
        try:
            if tokens is None:  # log in once per run: ToIV rate-limits logins (5/min per IP+account)
                tokens = login(s)
                token = tokens["h3"]
                fresh = describe(token)
                fresh["scope"] = jwt_claims(token).get("scope")
                log("INFO", f"attempt {attempt}: new ToIV token mode={s.token_mode} scope={fresh['scope']} "
                            f"fp={fresh['fingerprint']} sub={fresh['sub']} exp={fresh['exp']}")
            if mode == "dry-run":
                status.update(ok=True, fresh=fresh)
                write_status(s, status)
                return 0
            h3_ids, llm_ids, rev, replaced = write_token(canvas, tokens, s.sync_llm)
            retired = record_retired(s, replaced)
            got, _, _ = current_credential(canvas, s.sync_llm)
            if got != token:
                raise RuntimeError("read-back mismatch: canvas-api does not hold the new credential")
            after = describe(got)
            after["scope"] = jwt_claims(got).get("scope")
            status.update(ok=True, after=after, channels=h3_ids, llmChannels=llm_ids, revision=rev, attempts=attempt,
                          tokenMode=s.token_mode, retiredRecorded=retired)
            log("INFO", f"refreshed: h3={h3_ids} llm={llm_ids} revision={rev} scope={after['scope']} fp={after['fingerprint']} "
                        f"exp={after['exp']} hoursLeft={after['hoursLeft']} retiredRecorded={retired}")
            if after["hoursLeft"] is not None and after["hoursLeft"] < s.warn_hours:
                log("WARNING", f"new H3 credential is valid for only {after['hoursLeft']} h (< {s.warn_hours:g} h)")
                status["ok"] = False
            write_status(s, status)
            return 0 if status["ok"] else 1
        except Exception as e:
            last_err = e
            log("WARNING", f"refresh attempt {attempt}/{s.attempts} failed: {e}")
            if attempt < s.attempts:
                time.sleep(s.retry_base * (2 ** (attempt - 1)))
    left = (before or {}).get("hoursLeft")
    log("ERROR", f"H3 credential refresh FAILED after {s.attempts} attempts: {last_err}; "
                 f"current credential hoursLeft={left}")
    if left is not None and left < s.warn_hours:
        log("WARNING", f"H3 credential expires in {left} h (< {s.warn_hours:g} h)")
    status["error"] = str(last_err)
    write_status(s, status)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
