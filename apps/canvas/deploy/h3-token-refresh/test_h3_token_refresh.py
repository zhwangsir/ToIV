"""Offline tests for h3_token_refresh.py: fake ToIV + fake canvas-api on loopback.

Run: python3 -m unittest -v test_h3_token_refresh.py
"""
import base64, contextlib, hashlib, hmac, io, json, os, sys, tempfile, threading, time, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import h3_token_refresh as r  # noqa: E402

UID = "f659936d40144aa59b83c41d22314e0f"
KEY = b"k" * 64


def write(path, data, mode=None):
    with open(path, "wb" if isinstance(data, bytes) else "w") as fh:
        fh.write(data)
    if mode is not None:
        os.chmod(path, mode)


def jwt(sub, exp, scope=None):
    b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    claims = {"sub": sub, "exp": int(exp)}
    if scope:
        claims["scope"] = scope
    return f"{b({'alg': 'HS256'})}.{b(claims)}.sig-{sub}-{int(exp)}-{scope}"


class Fake:
    def __init__(self):
        self.login_status = 200
        self.logins = 0
        self.conflicts = 0
        self.put_status = 200
        self.revision = 7
        self.old = jwt("admin", time.time() + 30 * 3600)
        self.config = {"channels": [
            {"id": "h3", "apiKey": self.old, "modelProfiles": [{"model": "h3-t2v", "protocol": "toiv-h3"}]},
            {"id": "toiv-llm", "apiKey": self.old, "modelProfiles": [{"model": "qwen", "protocol": "openai-chat-completions"}]},
            {"id": "other", "apiKey": "keep-me", "modelProfiles": [{"model": "x", "protocol": "openai-images"}]},
        ]}
        self.issued = []
        self.scoped = {}  # token -> scope
        self.enforce_scope = True


def server(fake):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, code, body):
            raw = json.dumps(body).encode()
            self.send_response(code); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

        def gate_ok(self):
            h = self.headers.get("x-beeftv-gate-auth", "")
            try:
                v, uid, ts, sig = h.split(".")
            except ValueError:
                return False
            msg = f"v1\n{uid}\n{ts}\n{self.command}\n{self.path.split('?')[0]}".encode()
            return uid == UID and abs(time.time() - int(ts)) < 60 and hmac.compare_digest(sig, hmac.new(KEY, msg, hashlib.sha256).hexdigest())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            if self.path == "/api/auth/service-token":
                fake.logins += 1
                if fake.login_status != 200 or body.get("password") != "pw":
                    return self.send(fake.login_status if fake.login_status != 200 else 401, {"detail": "no"})
                scope = body.get("scope")
                t = jwt("svc", time.time() + 168 * 3600 + fake.logins, scope)
                fake.issued.append(t); fake.scoped[t] = scope
                return self.send(200, {"token": t, "scope": scope})
            if self.path == "/api/auth/login":
                fake.logins += 1
                if fake.login_status != 200 or body.get("password") != "pw":
                    return self.send(fake.login_status if fake.login_status != 200 else 401, {"detail": "no"})
                t = jwt("svc", time.time() + 168 * 3600 + fake.logins)
                fake.issued.append(t)
                return self.send(200, {"token": t})
            self.send(404, {})

        def do_GET(self):
            tok = self.headers.get("authorization", "")[7:]
            if self.path == "/api/auth/me":
                if tok not in fake.issued:
                    return self.send(401, {})
                return self.send(403 if tok in fake.scoped and fake.enforce_scope else 200, {"id": "svc"})
            if self.path.startswith("/api/jobs/lookup"):
                ok = tok in fake.issued and (fake.scoped.get(tok) in (None, "h3") or not fake.enforce_scope)
                return self.send(404 if ok else 403, {})
            if self.path == "/api/llm/v1/models":
                ok = tok in fake.issued and (fake.scoped.get(tok) in (None, "llm") or not fake.enforce_scope)
                return self.send(200 if ok else 403, {"data": []})
            if self.path == "/api/workspace/model-config":
                if not self.gate_ok():
                    return self.send(401, {"reason": "gate_identity_required"})
                return self.send(200, {"data": {"config": json.loads(json.dumps(fake.config)), "revision": fake.revision}})
            self.send(404, {})

        def do_PUT(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            if not self.gate_ok():
                return self.send(401, {})
            if fake.conflicts:
                fake.conflicts -= 1; fake.revision += 1
                return self.send(409, {})
            if fake.put_status != 200:
                return self.send(fake.put_status, {})
            if body.get("expectedRevision") != fake.revision:
                return self.send(409, {})
            fake.config = body["config"]; fake.revision += 1
            self.send(200, {"data": {"saved": True, "revision": fake.revision}})

    s = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.fake = Fake()
        self.srv = server(self.fake)
        base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        self.dir = tempfile.mkdtemp()
        key = os.path.join(self.dir, "gate_key"); write(key, KEY)
        cred = os.path.join(self.dir, "cred.env"); write(cred, "TOIV_H3_EMAIL=svc@x\nTOIV_H3_PASSWORD=pw\n", 0o600)
        self.env = {"TOIV_API": base, "CANVAS_API": base, "CANVAS_GATE_UID": UID, "CANVAS_GATE_KEY_FILE": key,
                    "H3_CRED_FILE": cred, "RETRY_BASE_SECONDS": "0", "REFRESH_ATTEMPTS": "3",
                    "STATUS_FILE": os.path.join(self.dir, "status.json")}

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()

    def run_main(self, *args, **env):
        out, err = io.StringIO(), io.StringIO()
        old = dict(os.environ)
        os.environ.clear(); os.environ.update({**self.env, **env})
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = r.main(list(args))
        finally:
            os.environ.clear(); os.environ.update(old)
        text = out.getvalue() + err.getvalue()
        for t in self.fake.issued + [self.fake.old]:
            self.assertNotIn(t, text, "a token leaked into the log")
        return code, text

    def status(self):
        with open(self.env["STATUS_FILE"]) as fh:
            return json.load(fh)

    def test_refresh_writes_scoped_service_token_to_h3_only(self):
        code, text = self.run_main()
        self.assertEqual(code, 0, text)
        ch = {c["id"]: c["apiKey"] for c in self.fake.config["channels"]}
        self.assertEqual(ch["h3"], self.fake.issued[-1])
        self.assertEqual(r.jwt_claims(ch["h3"]).get("scope"), "h3")
        self.assertEqual(ch["toiv-llm"], self.fake.old, "llm channel untouched by default")
        self.assertEqual(ch["other"], "keep-me")
        st = self.status()
        self.assertTrue(st["ok"]); self.assertEqual(st["after"]["scope"], "h3"); self.assertEqual(st["tokenMode"], "service")
        self.assertGreater(st["after"]["hoursLeft"], 167); self.assertLess(st["before"]["hoursLeft"], 31)
        self.assertIsNone(st["before"]["scope"])

    def test_llm_channel_gets_its_own_llm_scoped_token(self):
        code, text = self.run_main(SYNC_LLM_CHANNEL="1")
        self.assertEqual(code, 0, text)
        ch = {c["id"]: c["apiKey"] for c in self.fake.config["channels"]}
        self.assertEqual(r.jwt_claims(ch["h3"]).get("scope"), "h3")
        self.assertEqual(r.jwt_claims(ch["toiv-llm"]).get("scope"), "llm")
        self.assertNotEqual(ch["h3"], ch["toiv-llm"])

    def test_unscoped_token_is_refused(self):
        self.fake.enforce_scope = False  # a ToIV that ignores scopes must not get its token stored
        code, text = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("not scope-limited", text)
        self.assertEqual({c["id"]: c["apiKey"] for c in self.fake.config["channels"]}["h3"], self.fake.old)

    def test_legacy_login_mode_still_works_and_warns(self):
        code, text = self.run_main(TOKEN_MODE="login")
        self.assertEqual(code, 0, text)
        self.assertIn("TOKEN_MODE=login", text)
        self.assertIsNone(r.jwt_claims({c["id"]: c["apiKey"] for c in self.fake.config["channels"]}["h3"]).get("scope"))

    def test_retired_credentials_recorded_as_fingerprints_only(self):
        retired = os.path.join(self.dir, "retired.sha256")
        code, text = self.run_main(RETIRED_FILE=retired)
        self.assertEqual(code, 0, text)
        with open(retired) as fh:
            body = fh.read()
        self.assertEqual(body.split(), [hashlib.sha256(self.fake.old.encode()).hexdigest()])
        self.assertNotIn(self.fake.old, body)
        self.assertEqual(os.stat(retired).st_mode & 0o777, 0o600)
        self.run_main(RETIRED_FILE=retired)  # the replaced service token is appended, no duplicates
        with open(retired) as fh:
            self.assertEqual(len(fh.read().split()), 2)

    def test_revision_conflict_is_retried(self):
        self.fake.conflicts = 2
        code, text = self.run_main()
        self.assertEqual(code, 0, text)
        self.assertIn("revision conflict", text)

    def test_login_failure_retries_then_fails_and_warns(self):
        self.fake.login_status = 429
        code, text = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.fake.logins, 3)
        self.assertIn("FAILED after 3 attempts", text)
        self.assertIn("WARNING H3 credential expires in", text)  # old one has 30 h < 48 h
        self.assertEqual({c["id"]: c["apiKey"] for c in self.fake.config["channels"]}["h3"], self.fake.old)

    def test_canvas_failure_retries_without_relogin(self):
        self.fake.put_status = 500
        code, text = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.fake.logins, 1, "must not burn the ToIV login rate limit on canvas errors")
        self.assertEqual(text.count("WARNING refresh attempt"), 3)

    def test_check_mode_warns_under_threshold_and_is_read_only(self):
        code, text = self.run_main("--check")
        self.assertEqual(code, 1)
        self.assertIn("expires in", text)
        self.assertEqual(self.fake.logins, 0)
        code, _ = self.run_main("--check", WARN_HOURS="24")
        self.assertEqual(code, 0)

    def test_wrong_identity_key_is_rejected(self):
        bad = os.path.join(self.dir, "bad_key"); write(bad, b"z" * 64)
        code, text = self.run_main(CANVAS_GATE_KEY_FILE=bad)
        self.assertEqual(code, 1)
        self.assertIn("HTTP 401", text)

    def test_readable_credential_file_is_refused(self):
        os.chmod(self.env["H3_CRED_FILE"], 0o644)
        code, text = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("group/world readable", text)


if __name__ == "__main__":
    unittest.main()
