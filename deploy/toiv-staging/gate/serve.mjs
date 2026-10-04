// BeefTV staging web gate: static SPA + ToIV login gate + per-user BeefTV backend instances.
//
// Design (M3b-D):
//  * Every request except the login page, /auth/* and static assets needs a valid ToIV session.
//    The session cookie holds the user's own ToIV JWT (HttpOnly, SameSite=Strict); it is validated
//    against ToIV GET /api/auth/me (cached 60 s) and is NEVER forwarded to BeefTV.
//  * BeefTV is a single-workspace app, so isolation is per process: each ToIV user gets their own
//    beeftv-server (systemd --user unit beeftv-user@<uid>, 127.0.0.1:<port>, own data dir).
//    Canvases, tasks, assets, assistant history and channel credentials never mix.
//  * The user's ToIV JWT is written into their own instance's "ToIV H3" channel, so H3 jobs run
//    as that user in ToIV (ToIV-side isolation of jobs and outputs).
//  * The gate is the owner identity of the user's instance: after authentication it attaches that
//    instance's owner token (read from its data dir on core) to proxied /api calls. The token
//    never reaches the browser. No loopback/bootstrap shortcuts remain.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const PORT = Number(process.env.WEB_PORT || 8271);
const HOST = process.env.WEB_HOST || "0.0.0.0";
const ROOT = path.resolve(process.env.WEB_ROOT || "./dist");
const STAGING = process.env.STAGING_DIR || "/home/merlin/beeftv-staging";
const USERS = path.join(STAGING, "users");
const TOIV = new URL(process.env.TOIV_API || "http://127.0.0.1:8090");
const PORT_BASE = Number(process.env.USER_PORT_BASE || 8300);
const PORT_MAX = Number(process.env.USER_PORT_MAX || 8399);
const COOKIE = "toiv_session";
const GATE_DIR = path.join(STAGING, "gate");
const TYPES = {".html":"text/html; charset=utf-8",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".ico":"image/x-icon",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".wasm":"application/wasm",".mp4":"video/mp4",".webm":"video/webm",".mp3":"audio/mpeg",".wav":"audio/wav",".txt":"text/plain",".glb":"model/gltf-binary",".task":"application/octet-stream"};
const PUBLIC_FILES = new Set(["/logo.svg", "/favicon.svg", "/toiv-logo.svg", "/toiv-mark.svg", "/favicon.ico"]);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const UID_RE = /^[a-f0-9]{32}$/;

// ---------- ToIV session validation ----------
const meCache = new Map(); // sha256(token) -> {user, exp}
const hashTok = (t) => crypto.createHash("sha256").update(t).digest("hex");
function toivRequest(method, p, { token, body } = {}) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { accept: "application/json" };
    if (data) { headers["content-type"] = "application/json"; headers["content-length"] = data.length; }
    if (token) headers.authorization = `Bearer ${token}`;
    const r = http.request({ hostname: TOIV.hostname, port: TOIV.port, method, path: p, headers, timeout: 15000 }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} resolve({ status: res.statusCode || 0, json }); });
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", () => resolve({ status: 0, json: null }));
    if (data) r.write(data); r.end();
  });
}
async function validate(token) {
  if (!token || token.length > 4096) return null;
  const k = hashTok(token); const hit = meCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.user;
  const { status, json } = await toivRequest("GET", "/api/auth/me", { token });
  const u = json && (json.user || json);
  if (status !== 200 || !u || !UID_RE.test(String(u.id || ""))) { meCache.delete(k); return null; }
  const user = { id: u.id, name: u.display_name || u.name || u.username || "", email: u.email || "", role: u.role || "" };
  meCache.set(k, { user, exp: Date.now() + 60_000 });
  return user;
}
function cookieToken(req) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
function jwtExpSeconds(token) {
  try { const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); return Number(p.exp) || 0; } catch { return 0; }
}

// ---------- per-user instances ----------
const REG_FILE = path.join(USERS, "registry.json");
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }
function writePrivate(f, s) { fs.writeFileSync(f + ".tmp", s, { mode: 0o600 }); fs.renameSync(f + ".tmp", f); }
fs.mkdirSync(USERS, { recursive: true, mode: 0o700 });
function portFor(uid) {
  const reg = readJSON(REG_FILE, {});
  if (reg[uid]?.port) return reg[uid].port;
  const used = new Set(Object.values(reg).map((v) => v.port));
  let port = PORT_BASE; while (used.has(port)) port++;
  if (port > PORT_MAX) throw new Error("no free instance port");
  reg[uid] = { port, createdAt: new Date().toISOString() };
  writePrivate(REG_FILE, JSON.stringify(reg, null, 2));
  return port;
}
function systemctl(...args) {
  return new Promise((resolve) => execFile("systemctl", ["--user", ...args], { timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") })));
}
function instanceEnv(uid, port) {
  const base = fs.readFileSync(path.join(STAGING, "backend.env"), "utf8").split("\n")
    .filter((l) => l.trim() && !/^(CANVAS_BACKEND_ADDR|CANVAS_BACKEND_DATA_DIR|BEEFTV_UI_BOOTSTRAP)=/.test(l));
  base.push(`CANVAS_BACKEND_ADDR=127.0.0.1:${port}`, `CANVAS_BACKEND_DATA_DIR=${path.join(USERS, uid, "data")}`);
  return base.join("\n") + "\n";
}
function backendGet(port, p, extraHeaders = {}) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: "127.0.0.1", port, method: "GET", path: p, headers: { host: `127.0.0.1:${port}`, ...extraHeaders }, timeout: 5000 }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} resolve({ status: res.statusCode || 0, json }); });
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", () => resolve({ status: 0, json: null })); r.end();
  });
}
function backendPut(port, p, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ hostname: "127.0.0.1", port, method: "PUT", path: p, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": data.length }, timeout: 15000 }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} resolve({ status: res.statusCode || 0, json }); });
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", () => resolve({ status: 0, json: null })); r.write(data); r.end();
  });
}
async function waitHealthy(port, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { status } = await backendGet(port, "/api/workspace/model-config");
    if (status === 200) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const ensuring = new Map();
const ready = new Map(); // uid -> {port, tokenHash, at}
async function ensureInstance(uid, token) {
  if (!UID_RE.test(uid)) throw new Error("bad uid");
  const fresh = ready.get(uid);
  if (fresh && fresh.tokenHash === hashTok(token) && Date.now() - fresh.at < 15000) return fresh.port;
  const key = uid;
  while (ensuring.has(key)) await ensuring.get(key).catch(() => {});
  const p = (async () => {
    const port = portFor(uid);
    const dir = path.join(USERS, uid);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true, mode: 0o700 });
    writePrivate(path.join(dir, "backend.env"), instanceEnv(uid, port));
    const agentCfg = path.join(dir, "data", "agent_config.json");
    if (!fs.existsSync(agentCfg)) {
      const tpl = path.join(GATE_DIR, "agent_config.template.json");
      if (fs.existsSync(tpl)) writePrivate(agentCfg, fs.readFileSync(tpl, "utf8"));
    }
    let { status } = await backendGet(port, "/api/workspace/model-config");
    if (status !== 200) {
      const r = await systemctl("start", `beeftv-user@${uid}.service`);
      if (!r.ok) throw new Error("instance start failed");
      if (!(await waitHealthy(port))) throw new Error("instance not healthy");
    }
    await syncChannelToken(uid, port, token);
    return port;
  })();
  ensuring.set(key, p);
  try { const port = await p; ready.set(uid, { port, tokenHash: hashTok(token), at: Date.now() }); return port; }
  catch (e) { ready.delete(uid); throw e; }
  finally { ensuring.delete(key); }
}
// Provision the user's model config once from the sanitized template, and keep the ToIV H3
// channel credential equal to the user's current ToIV JWT (re-synced whenever the token changes).
async function syncChannelToken(uid, port, token) {
  const stFile = path.join(USERS, uid, "gate_state.json");
  const st = readJSON(stFile, {});
  const th = hashTok(token);
  if (st.provisioned && st.tokenHash === th) return;
  const cur = await backendGet(port, "/api/workspace/model-config");
  if (cur.status !== 200 || !cur.json?.data?.config) throw new Error("model-config unavailable");
  let cfg = cur.json.data.config;
  if (!st.provisioned) {
    const tpl = readJSON(path.join(GATE_DIR, "model-config.template.json"), null);
    if (tpl) cfg = { ...cfg, ...tpl, channels: [...(cfg.channels || []).filter((c) => !tpl.channels.some((t) => t.id === c.id)), ...tpl.channels] };
  }
  let hit = 0;
  for (const c of cfg.channels || []) {
    if ((c.modelProfiles || []).some((p) => p.protocol === "toiv-h3" || p.model === "h3-t2v")) { c.apiKey = token; hit++; }
  }
  const r = await backendPut(port, "/api/workspace/model-config", { config: cfg, expectedRevision: cur.json.data.revision });
  if (r.status !== 200) throw new Error(`model-config update failed (${r.status})`);
  writePrivate(stFile, JSON.stringify({ provisioned: true, tokenHash: th, h3Channels: hit, updatedAt: new Date().toISOString() }));
  log("provisioned/synced instance", uid.slice(0, 8), "port", port, "h3Channels", hit);
}
function ownerToken(uid) {
  try { return fs.readFileSync(path.join(USERS, uid, "data", "agent_owner_token"), "utf8").trim() || null; } catch { return null; }
}
// On gate start, bring every registered user's instance up so in-flight tasks resume.
(async () => {
  for (const uid of Object.keys(readJSON(REG_FILE, {}))) if (UID_RE.test(uid)) await systemctl("start", `beeftv-user@${uid}.service`);
})();

// ---------- HTTP helpers ----------
function sameOrigin(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true; // non-browser clients; cookie is SameSite=Strict anyway
  try { return new URL(src).host === String(req.headers.host || ""); } catch { return false; }
}
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); req.on("error", reject);
  });
}
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now(); const a = (attempts.get(ip) || []).filter((t) => now - t < 60_000); a.push(now); attempts.set(ip, a); return a.length > 10;
}
function sessionCookie(token, req) {
  const exp = jwtExpSeconds(token); const maxAge = exp ? Math.max(60, exp - Math.floor(Date.now() / 1000)) : 7 * 86400;
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function handleAuth(req, res, url) {
  if (url.pathname === "/auth/login" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
    const ip = req.socket.remoteAddress || "";
    if (rateLimited(ip)) return json(res, 429, { error: "too_many_attempts", message: "尝试过于频繁，请稍后再试" });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad_request" }); }
    const email = String(body.email || "").trim(), password = String(body.password || "");
    if (!email || !password) return json(res, 400, { error: "bad_request", message: "请输入账号与密码" });
    const r = await toivRequest("POST", "/api/auth/login", { body: { email, password } });
    const token = r.json && r.json.token;
    if (r.status !== 200 || !token) return json(res, r.status === 0 ? 502 : 401, { error: "login_failed", message: (r.json && (r.json.detail || r.json.message)) && typeof (r.json.detail || r.json.message) === "string" ? (r.json.detail || r.json.message) : "账号或密码错误" });
    const user = await validate(token);
    if (!user) return json(res, 401, { error: "login_failed", message: "ToIV 令牌校验失败" });
    try { await ensureInstance(user.id, token); } catch (e) { log("instance error", user.id.slice(0, 8), String(e.message)); return json(res, 503, { error: "workspace_unavailable", message: "个人工作区启动失败，请稍后重试" }); }
    log("login", user.id.slice(0, 8));
    return json(res, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email } }, { "set-cookie": sessionCookie(token, req) });
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
    return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }
  if (url.pathname === "/auth/me" && req.method === "GET") {
    const user = await validate(cookieToken(req));
    if (!user) return json(res, 401, { error: "unauthenticated" });
    return json(res, 200, { user: { id: user.id, name: user.name, email: user.email } });
  }
  return json(res, 404, { error: "not_found" });
}

function proxy(req, res, uid, port) {
  const headers = { ...req.headers };
  delete headers.cookie; delete headers["x-beeftv-owner"]; delete headers["x-beeftv-client"]; delete headers.authorization; delete headers.referer;
  headers.host = `127.0.0.1:${port}`;
  if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
  headers["x-forwarded-for"] = req.socket.remoteAddress || "";
  const owner = ownerToken(uid); if (owner) headers["x-beeftv-owner"] = owner;
  const p = http.request({ hostname: "127.0.0.1", port, method: req.method, path: req.url, headers }, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
  p.on("error", (e) => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad_gateway" })); });
  req.pipe(p);
}
function sendFile(res, file, cache) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": cache ? "public, max-age=31536000, immutable" : "no-cache", "referrer-policy": "no-referrer" });
  fs.createReadStream(file).pipe(res);
}
let indexCache = { mtime: 0, html: "" };
function sendIndex(res) {
  const f = path.join(ROOT, "index.html"); const st = fs.statSync(f);
  if (st.mtimeMs !== indexCache.mtime) {
    const chip = fs.existsSync(path.join(GATE_DIR, "session-chip.html")) ? fs.readFileSync(path.join(GATE_DIR, "session-chip.html"), "utf8") : "";
    indexCache = { mtime: st.mtimeMs, html: fs.readFileSync(f, "utf8").replace("</body>", chip + "</body>") };
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "referrer-policy": "no-referrer" });
  res.end(indexCache.html);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/auth/")) return await handleAuth(req, res, url);
    if (url.pathname === "/login") return sendFile(res, path.join(GATE_DIR, "login.html"), false);
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    const isStatic = rel.startsWith("/assets/") || PUBLIC_FILES.has(rel);
    if (isStatic) {
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
      return fs.stat(file, (err, st) => (!err && st.isFile()) ? sendFile(res, file, rel.startsWith("/assets/")) : (res.writeHead(404), res.end()));
    }
    const token = cookieToken(req);
    const user = await validate(token);
    const isApi = url.pathname.startsWith("/api/") || url.pathname === "/oauth/linuxdo/callback";
    if (!user) {
      if (isApi) return json(res, 401, { error: "unauthenticated", message: "请先登录 ToIV 账号" });
      res.writeHead(302, { location: "/login?next=" + encodeURIComponent(url.pathname + url.search), "cache-control": "no-store" });
      return res.end();
    }
    if (isApi) {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
      let port;
      try { port = await ensureInstance(user.id, token); } catch (e) { return json(res, 503, { error: "workspace_unavailable" }); }
      return proxy(req, res, user.id, port);
    }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (!err && st.isFile() && path.basename(file) !== "index.html") return sendFile(res, file, false);
      sendIndex(res); // SPA fallback
    });
  } catch (e) {
    log("error", String(e && e.message));
    if (!res.headersSent) json(res, 500, { error: "internal" }); else res.end();
  }
}).listen(PORT, HOST, () => log(`beeftv gate on ${HOST}:${PORT} root=${ROOT} toiv=${TOIV.href}`));
