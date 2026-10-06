// BeefTV staging web gate: static SPA + ToIV login gate + per-user BeefTV backend instances.
//
// Design (M3b-D, on-demand instances M4):
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
//  * M6a (prod pool): with GATE_SIGNING_KEY_FILE every gate->backend request also carries
//    X-Beeftv-Gate-Auth, an HMAC over uid/time/method/path with a per-user key derived from the
//    gate master key. The backend (BEEFTV_GATE_UID/BEEFTV_GATE_KEY_FILE) rejects anything else, so a
//    process that can reach 127.0.0.1:<port> still cannot act as that user.
//  * M6a (sub-path): GATE_PREFIX=/studio mounts everything under the prefix (ToIV Next proxies
//    /studio/* here); GATE_LOGIN_URL hands login to ToIV (localStorage token -> /auth/exchange).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";

const PORT = Number(process.env.WEB_PORT || 8271);
const HOST = process.env.WEB_HOST || "0.0.0.0";
const ROOT = path.resolve(process.env.WEB_ROOT || "./dist");
const STAGING = process.env.STAGING_DIR || "/home/merlin/beeftv-staging";
const USERS = path.join(STAGING, "users");
const TOIV = new URL(process.env.TOIV_API || "http://127.0.0.1:8090");
// Assistant channel (toiv-llm): ToIV OpenAI-compatible proxy /api/llm/v1 (ToIV main 202dc565), auth = user JWT.
const LLM_CHANNEL_BASE = process.env.GATE_LLM_CHANNEL_BASE || `${TOIV.origin}/api/llm/v1`;
const PORT_BASE = Number(process.env.USER_PORT_BASE || 8300);
const PORT_MAX = Number(process.env.USER_PORT_MAX || 8399);
const COOKIE = "toiv_session";
const PREFIX = String(process.env.GATE_PREFIX || "").trim().replace(/\/+$/, ""); // "" (staging) | "/studio"
const UNIT_TEMPLATE = process.env.GATE_UNIT_TEMPLATE || "beeftv-user@";
const COOKIE_SECURE = String(process.env.GATE_COOKIE_SECURE || "auto"); // "1": always; "auto": X-Forwarded-Proto
const PUBLIC_ORIGINS = String(process.env.GATE_PUBLIC_ORIGIN || "").split(",").map((v) => v.trim().replace(/\/+$/, "")).filter(Boolean);
const LOGIN_URL = String(process.env.GATE_LOGIN_URL || ""); // prod: "/?view=home" (ToIV login); unset: own form
const ENTRY_FILE = process.env.GATE_ENTRY_FILE || path.join(STAGING, "ENTRY_ON");
const SIGNING_KEY_FILE = process.env.GATE_SIGNING_KEY_FILE || "";
const STREAM_PING_MS = Math.max(1000, Number(process.env.GATE_STREAM_PING_MS || 20_000));
const pub = (p) => PREFIX + p;
if (PREFIX && !/^\/[a-z0-9-]+$/.test(PREFIX)) throw new Error("GATE_PREFIX must look like /studio");
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
// Returns {user, status}: status is ToIV's answer (0 = ToIV unreachable), so callers can tell
// "token rejected" (401/403) from "cannot check right now" (0/5xx).
async function validateStatus(token) {
  if (!token || token.length > 4096) return { user: null, status: 401 };
  const k = hashTok(token); const hit = meCache.get(k);
  if (hit && hit.exp > Date.now()) return { user: hit.user, status: 200 };
  const { status, json } = await toivRequest("GET", "/api/auth/me", { token });
  const u = json && (json.user || json);
  if (status !== 200 || !u || !UID_RE.test(String(u.id || ""))) { meCache.delete(k); return { user: null, status: status === 200 ? 401 : status }; }
  const user = { id: u.id, name: u.display_name || u.name || u.username || "", email: u.email || "", role: u.role || "" };
  meCache.set(k, { user, exp: Date.now() + 60_000 });
  return { user, status };
}
async function validate(token) { return (await validateStatus(token)).user; }
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

// ---------- per-user instances (on demand, M4) ----------
// Lifecycle: login/any authenticated request -> want(uid) -> spawn if a slot is free, else FIFO queue.
// Ports come from a loopback pool and are released on reclaim; the data dir (users/<uid>/data) persists.
// Reclaim: idle > GATE_IDLE_MS (no authenticated request from that user) AND no queued/running task.
// Crash: the unit has Restart=always; the gate health monitor also restarts a dead ready instance.
const IDLE_MS = Number(process.env.GATE_IDLE_MS || 30 * 60_000);
const MAX_INSTANCES = Math.max(1, Number(process.env.GATE_MAX_INSTANCES || 6));
const SWEEP_MS = Number(process.env.GATE_SWEEP_MS || 60_000);
const HEALTH_MS = Number(process.env.GATE_HEALTH_MS || 5_000);
const QUEUE_TTL_MS = 60_000; // queued users who stop polling (tab closed) drop out
const REG_FILE = path.join(USERS, "registry.json");
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }
function writePrivate(f, s) { fs.writeFileSync(f + ".tmp", s, { mode: 0o600 }); fs.renameSync(f + ".tmp", f); }
fs.mkdirSync(USERS, { recursive: true, mode: 0o700 });
function registryNote(uid, patch) {
  const reg = readJSON(REG_FILE, {});
  reg[uid] = { ...(reg[uid] || { createdAt: new Date().toISOString() }), ...patch };
  writePrivate(REG_FILE, JSON.stringify(reg, null, 2));
}
function systemctl(...args) {
  return new Promise((resolve) => execFile("systemctl", ["--user", ...args], { timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "").trim() + String(stderr || "") })));
}
const unitOf = (uid) => `${UNIT_TEMPLATE}${uid}.service`;
// ---------- gate-signed identity (M6a) ----------
let masterKey = "";
if (SIGNING_KEY_FILE) {
  if (!fs.existsSync(SIGNING_KEY_FILE)) {
    fs.mkdirSync(path.dirname(SIGNING_KEY_FILE), { recursive: true, mode: 0o700 });
    writePrivate(SIGNING_KEY_FILE, crypto.randomBytes(48).toString("hex"));
  }
  masterKey = fs.readFileSync(SIGNING_KEY_FILE, "utf8").trim();
  if (masterKey.length < 32) throw new Error("gate signing key too short");
}
const userKey = (uid) => crypto.createHmac("sha256", masterKey).update(`beeftv-gate-user-key\n${uid}`).digest("hex");
const gateKeyFile = (uid) => path.join(USERS, uid, "gate_key");
function gateAuth(uid, method, reqPath) {
  const ts = Math.floor(Date.now() / 1000);
  const p = String(reqPath || "/").split("?")[0] || "/";
  const sig = crypto.createHmac("sha256", userKey(uid)).update(`v1\n${uid}\n${ts}\n${String(method).toUpperCase()}\n${p}`).digest("hex");
  return `v1.${uid}.${ts}.${sig}`;
}
function instanceEnv(uid, port) {
  const base = fs.readFileSync(path.join(STAGING, "backend.env"), "utf8").split("\n")
    .filter((l) => l.trim() && !/^(CANVAS_BACKEND_ADDR|CANVAS_BACKEND_DATA_DIR|BEEFTV_UI_BOOTSTRAP|BEEFTV_GATE_UID|BEEFTV_GATE_KEY_FILE)=/.test(l));
  base.push(`CANVAS_BACKEND_ADDR=127.0.0.1:${port}`, `CANVAS_BACKEND_DATA_DIR=${path.join(USERS, uid, "data")}`);
  if (masterKey) base.push(`BEEFTV_GATE_UID=${uid}`, `BEEFTV_GATE_KEY_FILE=${gateKeyFile(uid)}`);
  return base.join("\n") + "\n";
}
function backendReq(method, port, p, { body, headers = {}, timeout = 5000, uid } = {}) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (masterKey && uid) h["x-beeftv-gate-auth"] = gateAuth(uid, method, p);
    if (data) { h["content-type"] = "application/json"; h["content-length"] = data.length; }
    const r = http.request({ hostname: "127.0.0.1", port, method, path: p, headers: h, timeout }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} resolve({ status: res.statusCode || 0, json }); });
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", () => resolve({ status: 0, json: null }));
    if (data) r.write(data); r.end();
  });
}
const backendGet = (uid, port, p, headers) => backendReq("GET", port, p, { headers, uid });
const backendPut = (uid, port, p, body) => backendReq("PUT", port, p, { body, timeout: 15000, uid });
const healthy = async (uid, port) => (await backendGet(uid, port, "/api/workspace/model-config")).status === 200;
async function waitHealthy(uid, port, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await healthy(uid, port)) return true; await new Promise((r) => setTimeout(r, 400)); }
  return false;
}
function portFree(port) {
  return new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.listen(port, "127.0.0.1", () => s.close(() => resolve(true))); });
}
async function allocPort() {
  const used = new Set([...inst.values()].map((e) => e.port));
  for (let p = PORT_BASE; p <= PORT_MAX; p++) if (!used.has(p) && await portFree(p)) return p;
  throw new Error("port pool exhausted");
}
function ownerToken(uid) {
  try { return fs.readFileSync(path.join(USERS, uid, "data", "agent_owner_token"), "utf8").trim() || null; } catch { return null; }
}

const inst = new Map();   // uid -> {port, state:'starting'|'ready'|'stopping', lastActive, startedAt, token, tokenHash, synced, misses}
const queue = [];         // [{uid, lastPoll}]
const failedAt = new Map(); // uid -> ts of last failed start (10 s backoff)
const slotsUsed = () => inst.size;

// Called on every authenticated hit. Returns {state, position?}.
function want(uid, token) {
  if (!UID_RE.test(uid)) throw new Error("bad uid");
  const e = inst.get(uid);
  if (e) {
    e.lastActive = Date.now();
    if (token && e.tokenHash !== hashTok(token)) { e.token = token; e.tokenHash = hashTok(token); e.synced = false; }
    if (e.state === "ready" && !e.synced && e.token) kickSync(uid, e);
    return { state: e.state === "ready" ? "ready" : "starting" };
  }
  if (failedAt.has(uid) && Date.now() - failedAt.get(uid) < 10_000) return { state: "error" };
  const qi = queue.findIndex((q) => q.uid === uid);
  if (qi < 0 && slotsUsed() < MAX_INSTANCES && queue.length === 0) { spawn(uid, token); return { state: "starting" }; }
  if (qi < 0) { queue.push({ uid, token, lastPoll: Date.now() }); log("queued", uid.slice(0, 8), "pos", queue.length); }
  else { queue[qi].lastPoll = Date.now(); if (token) queue[qi].token = token; }
  pumpQueue();
  const pos = queue.findIndex((q) => q.uid === uid);
  return pos < 0 ? { state: "starting" } : { state: "queued", position: pos + 1 };
}
function pumpQueue() {
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) if (now - queue[i].lastPoll > QUEUE_TTL_MS) { log("queue drop", queue[i].uid.slice(0, 8)); queue.splice(i, 1); }
  while (queue.length && slotsUsed() < MAX_INSTANCES) { const q = queue.shift(); if (!inst.has(q.uid)) spawn(q.uid, q.token); }
}
function spawn(uid, token) {
  const e = { port: 0, state: "starting", lastActive: Date.now(), startedAt: Date.now(), token: token || null, tokenHash: token ? hashTok(token) : "", synced: false, misses: 0 };
  inst.set(uid, e);
  (async () => {
    const t0 = Date.now();
    e.port = await allocPort();
    const dir = path.join(USERS, uid);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true, mode: 0o700 });
    if (masterKey) writePrivate(gateKeyFile(uid), userKey(uid));
    writePrivate(path.join(dir, "backend.env"), instanceEnv(uid, e.port));
    const agentCfg = path.join(dir, "data", "agent_config.json");
    const tpl = path.join(GATE_DIR, "agent_config.template.json");
    if (!fs.existsSync(agentCfg) && fs.existsSync(tpl)) writePrivate(agentCfg, fs.readFileSync(tpl, "utf8"));
    registryNote(uid, { lastPort: e.port, lastStart: new Date().toISOString() });
    const r = await systemctl("restart", unitOf(uid)); // restart: also picks up a fresh env/port
    if (!r.ok) throw new Error("unit start failed");
    if (!(await waitHealthy(uid, e.port))) throw new Error("instance not healthy");
    if (e.token) await syncChannelToken(uid, e.port, e.token);
    e.synced = !!e.token; e.state = "ready"; e.lastActive = Date.now(); failedAt.delete(uid);
    warmAssistant(uid, e);
    log("spawned", uid.slice(0, 8), "port", e.port, "in", Date.now() - t0, "ms", `(${slotsUsed()}/${MAX_INSTANCES})`);
  })().catch(async (err) => {
    log("spawn failed", uid.slice(0, 8), String(err.message));
    failedAt.set(uid, Date.now());
    await systemctl("stop", unitOf(uid));
    if (inst.get(uid) === e) inst.delete(uid);
    pumpQueue();
  });
}
const syncing = new Map();
function kickSync(uid, e) {
  if (syncing.has(uid) || (e.syncFailAt && Date.now() - e.syncFailAt < 30_000)) return;
  const tok = e.token;
  syncing.set(uid, syncChannelToken(uid, e.port, tok)
    .then(() => { if (e.token === tok) e.synced = true; warmAssistant(uid, e); })
    .catch((err) => { e.syncFailAt = Date.now(); log("sync failed", uid.slice(0, 8), String(err.message)); })
    .finally(() => syncing.delete(uid)));
}
// Provision the user's model config once from the sanitized template, and keep the ToIV H3
// channel credential equal to the user's current ToIV JWT (re-synced whenever the token changes).
async function syncChannelToken(uid, port, token) {
  const stFile = path.join(USERS, uid, "gate_state.json");
  const st = readJSON(stFile, {});
  const th = hashTok(token);
  if (st.provisioned && st.tokenHash === th && st.llmv === 2) return;
  const cur = await backendGet(uid, port, "/api/workspace/model-config");
  if (cur.status !== 200 || !cur.json?.data?.config) throw new Error("model-config unavailable");
  let cfg = cur.json.data.config;
  if (!st.provisioned) {
    const tpl = readJSON(path.join(GATE_DIR, "model-config.template.json"), null);
    if (tpl) cfg = { ...cfg, ...tpl, channels: [...(cfg.channels || []).filter((c) => !tpl.channels.some((t) => t.id === c.id)), ...tpl.channels] };
  }
  let hit = 0;
  for (const c of cfg.channels || []) {
    if ((c.modelProfiles || []).some((p) => p.protocol === "toiv-h3" || p.model === "h3-t2v")) { c.apiKey = token; hit++; }
    if (c.id === "toiv-llm") { c.baseUrl = LLM_CHANNEL_BASE; c.apiKey = token; } // never the internal LLM address
  }
  const r = await backendPut(uid, port, "/api/workspace/model-config", { config: cfg, expectedRevision: cur.json.data.revision });
  if (r.status !== 200) throw new Error(`model-config update failed (${r.status})`);
  writePrivate(stFile, JSON.stringify({ provisioned: true, tokenHash: th, llmv: 2, h3Channels: hit, updatedAt: new Date().toISOString() }));
  log("provisioned/synced instance", uid.slice(0, 8), "port", port, "h3Channels", hit);
}
// M5: keep the assistant host warm while a workspace is up. GET /api/assistant/status (loopback only)
// launches the host when it is not running, so opening the panel never meets a cold host. After a
// (re)start it polls until the host reports available; reasons other than host_starting (e.g. model
// not configured yet) end the attempt and the panel shows its own notice.
const WARM_EVERY_MS = Number(process.env.GATE_ASSISTANT_WARM_MS || 10_000);
async function warmAssistant(uid, e, loop = true) {
  if (!e || e.warming || e.state !== "ready" || !e.port) return;
  e.warming = true; e.warmAt = Date.now();
  const t0 = Date.now(), end = t0 + (loop ? 90_000 : 0);
  try {
    do {
      const r = await backendGet(uid, e.port, "/api/assistant/status");
      const d = r.json && r.json.data;
      if (d && d.available) { if (!e.warm) log("assistant warm", uid.slice(0, 8), "port", e.port, "in", Date.now() - t0, "ms"); e.warm = true; return; }
      e.warm = false;
      if (!d || d.reason !== "host_starting") return;
      await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < end && e.state === "ready");
  } finally { e.warming = false; }
}
async function inflightTasks(uid, port) {
  const owner = ownerToken(uid);
  const r = await backendGet(uid, port, "/api/tasks", owner ? { "x-beeftv-owner": owner } : {});
  if (r.status !== 200 || !Array.isArray(r.json?.data)) return -1; // unknown -> treat as busy
  return r.json.data.filter((t) => t.status === "queued" || t.status === "running").length;
}
// Idle reclaim.
setInterval(async () => {
  const now = Date.now();
  for (const [uid, e] of inst) {
    if (e.state !== "ready" || now - e.lastActive < IDLE_MS) continue;
    const n = await inflightTasks(uid, e.port);
    if (n !== 0) { if (!e.busyLogged) log("idle but busy, keep", uid.slice(0, 8), "inflight", n); e.busyLogged = true; continue; }
    e.busyLogged = false;
    if (Date.now() - e.lastActive < IDLE_MS) continue; // became active meanwhile
    e.state = "stopping";
    await systemctl("stop", unitOf(uid));
    inst.delete(uid);
    registryNote(uid, { lastReclaim: new Date().toISOString() });
    log("reclaimed idle", uid.slice(0, 8), "port", e.port, "idle", Math.round((now - e.lastActive) / 1000), "s", `(${slotsUsed()}/${MAX_INSTANCES})`);
    pumpQueue();
  }
  pumpQueue();
}, SWEEP_MS).unref();
// Crash recovery: systemd (Restart=always) normally respawns within 3 s; the gate marks the instance
// "starting" while it is down and restarts the unit itself if systemd gave up.
setInterval(async () => {
  for (const [uid, e] of inst) {
    if (e.state !== "ready" || e.recovering) continue;
    if (await healthy(uid, e.port)) { e.misses = 0; if (Date.now() - (e.warmAt || 0) > WARM_EVERY_MS) warmAssistant(uid, e); continue; }
    if (++e.misses < 2) continue;
    e.recovering = true; e.state = "starting";
    log("instance down, recovering", uid.slice(0, 8), "port", e.port);
    (async () => {
      if (!(await waitHealthy(uid, e.port, 15000))) {
        const st = (await systemctl("is-active", unitOf(uid))).out.split("\n")[0];
        if (["failed", "inactive"].includes(st)) { log("unit state", uid.slice(0, 8), st, "-> restart"); await systemctl("restart", unitOf(uid)); }
        else log("unit state", uid.slice(0, 8), st, "-> waiting for systemd");
        if (!(await waitHealthy(uid, e.port, 120000))) throw new Error("respawn failed");
      }
      e.state = "ready"; e.misses = 0; log("instance recovered", uid.slice(0, 8)); e.warm = false; warmAssistant(uid, e);
    })().catch(async (err) => { log("recover failed", uid.slice(0, 8), String(err.message)); await systemctl("stop", unitOf(uid)); inst.delete(uid); failedAt.set(uid, Date.now()); pumpQueue(); })
      .finally(() => { e.recovering = false; });
  }
}, HEALTH_MS).unref();
// Gate (re)start: adopt instances that are still running (their tasks keep going); nothing else is started.
(async () => {
  for (const uid of Object.keys(readJSON(REG_FILE, {}))) {
    if (!UID_RE.test(uid)) continue;
    const act = await systemctl("is-active", unitOf(uid));
    if (act.out.split("\n")[0] !== "active") continue;
    const m = /CANVAS_BACKEND_ADDR=127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(path.join(USERS, uid, "backend.env"), "utf8"));
    const port = m && Number(m[1]);
    if (masterKey && !fs.existsSync(gateKeyFile(uid))) { await systemctl("stop", unitOf(uid)); log("stopped unsigned leftover", uid.slice(0, 8)); continue; }
    if (port && await waitHealthy(uid, port, 20000)) {
      inst.set(uid, { port, state: "ready", lastActive: Date.now(), startedAt: Date.now(), token: null, tokenHash: "", synced: false, misses: 0 });
      log("adopted running instance", uid.slice(0, 8), "port", port); warmAssistant(uid, inst.get(uid));
    } else { await systemctl("stop", unitOf(uid)); log("stopped unhealthy leftover", uid.slice(0, 8)); }
  }
  log(`instance manager: max=${MAX_INSTANCES} idle=${IDLE_MS}ms sweep=${SWEEP_MS}ms pool=${PORT_BASE}-${PORT_MAX} adopted=${inst.size}`);
})();
function statusMessage(r) {
  if (r.state === "queued") return `当前同时在线的工作区已满（${MAX_INSTANCES}/${MAX_INSTANCES}），你排在第 ${r.position} 位，有空位后自动进入`;
  if (r.state === "error") return "工作区启动失败，正在重试…";
  if (r.state === "ready") return "已就绪";
  return "工作区启动中…";
}

// ---------- HTTP helpers ----------
// Behind ToIV Next the Host header may be the loopback target, so with GATE_PUBLIC_ORIGIN set the
// browser Origin must be one of those origins; otherwise (staging) it must match Host/X-Forwarded-Host.
function sameOrigin(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true; // non-browser clients; cookie is SameSite=Strict anyway
  let o; try { o = new URL(src); } catch { return false; }
  if (PUBLIC_ORIGINS.length) return PUBLIC_ORIGINS.includes(o.origin);
  const hosts = [req.headers.host, String(req.headers["x-forwarded-host"] || "").split(",")[0]]
    .map((h) => String(h || "").trim().toLowerCase()).filter(Boolean);
  return hosts.includes(o.host.toLowerCase());
}
// Behind a loopback proxy (ToIV Next / OpenResty) every peer is 127.0.0.1: rate-limit by the
// forwarded client address instead.
function clientIp(req) {
  const peer = req.socket.remoteAddress || "";
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff && /^(127\.|::1$|::ffff:127\.)/.test(peer) ? xff : peer;
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
const COOKIE_PATH = PREFIX || "/";
function cookieSecure(req) {
  return COOKIE_SECURE === "1" || (COOKIE_SECURE === "auto" && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") ? "; Secure" : "";
}
function sessionCookie(token, req) {
  const exp = jwtExpSeconds(token); const maxAge = exp ? Math.max(60, exp - Math.floor(Date.now() / 1000)) : 7 * 86400;
  return `${COOKIE}=${encodeURIComponent(token)}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSecure(req)}`;
}
const clearCookie = (req) => `${COOKIE}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure(req)}`;

async function handleAuth(req, res, url) {
  if (url.pathname === "/auth/login" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
    const ip = clientIp(req);
    if (rateLimited(ip)) return json(res, 429, { error: "too_many_attempts", message: "尝试过于频繁，请稍后再试" });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad_request" }); }
    const email = String(body.email || "").trim(), password = String(body.password || "");
    if (!email || !password) return json(res, 400, { error: "bad_request", message: "请输入账号与密码" });
    const r = await toivRequest("POST", "/api/auth/login", { body: { email, password } });
    const token = r.json && r.json.token;
    if (r.status !== 200 || !token) return json(res, r.status === 0 ? 502 : 401, { error: "login_failed", message: (r.json && (r.json.detail || r.json.message)) && typeof (r.json.detail || r.json.message) === "string" ? (r.json.detail || r.json.message) : "账号或密码错误" });
    const user = await validate(token);
    if (!user) return json(res, 401, { error: "login_failed", message: "ToIV 令牌校验失败" });
    try { want(user.id, token); } catch (e) { log("instance error", user.id.slice(0, 8), String(e.message)); }
    log("login", user.id.slice(0, 8));
    return json(res, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email } }, { "set-cookie": sessionCookie(token, req) });
  }
  // M6a: ToIV owns login on the product domain. The page holds the ToIV JWT in localStorage and
  // trades it for this gate's HttpOnly cookie (same validation as /auth/login, no password here).
  if (url.pathname === "/auth/exchange" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
    if (rateLimited(clientIp(req))) return json(res, 429, { error: "too_many_attempts", message: "尝试过于频繁，请稍后再试" });
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return json(res, 400, { error: "bad_request" });
    const { user, status } = await validateStatus(token);
    if (!user) return status === 401 || status === 403 ? json(res, 401, { error: "unauthenticated", message: "ToIV 登录已失效" }) : json(res, 502, { error: "toiv_unavailable", message: "暂时无法校验登录，请稍后重试" });
    try { want(user.id, token); } catch (e) { log("instance error", user.id.slice(0, 8), String(e.message)); }
    log("exchange", user.id.slice(0, 8));
    return json(res, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email } }, { "set-cookie": sessionCookie(token, req) });
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
    return json(res, 200, { ok: true }, { "set-cookie": clearCookie(req) });
  }
  if (url.pathname === "/auth/status" && req.method === "GET") {
    const token = cookieToken(req); const user = await validate(token);
    if (!user) return json(res, 401, { error: "unauthenticated" });
    const r = want(user.id, token);
    return json(res, 200, { ...r, message: statusMessage(r) });
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
  delete headers["x-beeftv-gate-auth"]; delete headers["x-desktop-token"]; delete headers["x-beeftv-agent-token"];
  headers.host = `127.0.0.1:${port}`;
  if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
  headers["x-forwarded-for"] = clientIp(req);
  const owner = ownerToken(uid); if (owner) headers["x-beeftv-owner"] = owner;
  if (masterKey) headers["x-beeftv-gate-auth"] = gateAuth(uid, req.method, req.url);
  const p = http.request({ hostname: "127.0.0.1", port, method: req.method, path: req.url, headers }, (up) => {
    // Never let an edge proxy (OpenResty location /) buffer API answers; SSE also gets comment
    // heartbeats between events so idle streams outlive a 300 s proxy_read_timeout.
    const sse = String(up.headers["content-type"] || "").includes("text/event-stream");
    const h = { ...up.headers, "x-accel-buffering": "no" };
    if (!sse) { res.writeHead(up.statusCode || 502, h); return up.pipe(res); }
    h["cache-control"] = "no-cache, no-transform"; delete h["content-length"];
    res.writeHead(up.statusCode || 502, h); res.flushHeaders?.();
    let tail = "\n\n", last = Date.now();
    const ping = setInterval(() => { if (Date.now() - last >= STREAM_PING_MS && tail.endsWith("\n\n")) { res.write(": ping\n\n"); last = Date.now(); } }, Math.min(5000, STREAM_PING_MS));
    const stop = () => clearInterval(ping);
    up.on("data", (c) => { res.write(c); last = Date.now(); tail = (tail + c.toString("latin1")).slice(-2); });
    up.on("end", () => { stop(); res.end(); });
    up.on("error", () => { stop(); res.end(); });
    res.on("close", () => { stop(); up.destroy(); });
  });
  p.on("error", (e) => { const ie = inst.get(uid); if (ie && ie.state === "ready") ie.misses = 9; if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad_gateway" })); });
  req.pipe(p);
}
function sendFile(res, file, cache) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": cache ? "public, max-age=31536000, immutable" : "no-cache", "referrer-policy": "no-referrer" });
  fs.createReadStream(file).pipe(res);
}
function prefixGateHtml(html) {
  if (!PREFIX) return html;
  return html.replace(/(["'`(])\/(favicon\.svg|logo\.svg|auth\/|__toiv\/|login\?|static\/)/g, `$1${PREFIX}/$2`)
    .replace(/\|\|"\/"/g, `||"${PREFIX}/"`).replace(/\?n:"\/"/g, `?n:"${PREFIX}/"`);
}
function sendGatePage(res, name) {
  const idx = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  // index-*.css carries the Inter font faces; application-*.css carries globals.css (the --user-* / .dark tokens).
  const app = fs.readdirSync(path.join(ROOT, "static")).filter((f) => /^application-[\w-]+\.css$/.test(f)).map((f) => `<link rel="stylesheet" href="${pub("/static/")}${f}">`);
  const css = [...(idx.match(/<link rel="stylesheet"[^>]*>/g) || []), ...app].join("\n");
  const style = fs.readFileSync(path.join(GATE_DIR, "gate-style.html"), "utf8");
  const raw = fs.readFileSync(path.join(GATE_DIR, name), "utf8");
  // handoff.html builds its URLs from __GATE_PREFIX__ itself; prefixing it again would double the prefix.
  const html = (name === "handoff.html" ? raw : prefixGateHtml(raw)).replace("<!--SPA_CSS-->", css).replace("<!--GATE_STYLE-->", style)
    .replace(/__GATE_PREFIX__/g, PREFIX).replace(/__GATE_LOGIN_URL__/g, LOGIN_URL.replace(/[<>"'\\]/g, ""));
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(html);
}
let indexCache = { mtime: 0, html: "" };
function sendIndex(res) {
  const f = path.join(ROOT, "index.html"); const st = fs.statSync(f);
  if (st.mtimeMs !== indexCache.mtime) {
    // M4: the floating session chip is gone; account + 退出 live in the sidebar avatar menu (SPA).
    indexCache = { mtime: st.mtimeMs, html: fs.readFileSync(f, "utf8") };
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "referrer-policy": "no-referrer" });
  res.end(indexCache.html);
}

http.createServer(async (req, res) => {
  try {
    res.setHeader("x-accel-buffering", "no"); // M6a: nothing under the mount is buffered by an edge proxy
    let url = new URL(req.url, "http://x");
    if (PREFIX) {
      // 2026-10-06 cutover 修复:toiv-web 尾斜杠规范化(308 /studio/ → /studio)与本机 308(/studio → /studio/)
      // 互相成环。/studio 与 /studio/ 一视同仁:内部归一化为 "/",直接继续服务(不再 30x)。
      if (url.pathname === PREFIX) {
        req.url = "/" + (url.search || "");
        url = new URL(req.url, "http://x");
      } else if (!url.pathname.startsWith(PREFIX + "/")) {
        return json(res, 404, { error: "not_found" });
      } else {
        req.url = req.url.slice(PREFIX.length) || "/";
        url = new URL(req.url, "http://x");
      }
    }
    // Entry switch for ToIV's "/?view=home" redirect: file present = BeefTV is the product UI.
    if (url.pathname === "/entry.json") return json(res, 200, { enabled: fs.existsSync(ENTRY_FILE) });
    if (url.pathname.startsWith("/auth/")) return await handleAuth(req, res, url);
    if (url.pathname === "/login") return sendGatePage(res, LOGIN_URL ? "handoff.html" : "login.html");
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    const isStatic = rel.startsWith("/assets/") || rel.startsWith("/static/") || PUBLIC_FILES.has(rel);
    if (isStatic) {
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
      return fs.stat(file, (err, st) => (!err && st.isFile()) ? sendFile(res, file, rel.startsWith("/assets/") || rel.startsWith("/static/")) : (res.writeHead(404), res.end()));
    }
    const token = cookieToken(req);
    const user = await validate(token);
    const isApi = url.pathname.startsWith("/api/") || url.pathname === "/oauth/linuxdo/callback";
    if (!user) {
      if (isApi) return json(res, 401, { error: "unauthenticated", message: "请先登录 ToIV 账号" });
      if (LOGIN_URL && (req.headers.accept || "").includes("text/html")) return sendGatePage(res, "handoff.html");
      res.writeHead(302, { location: pub("/login?next=") + encodeURIComponent(pub(url.pathname + url.search)), "cache-control": "no-store" });
      return res.end();
    }
    const st = want(user.id, token);
    if (isApi) {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) return json(res, 403, { error: "cross_origin" });
      const e = inst.get(user.id);
      if (st.state !== "ready" || !e) return json(res, 503, { error: "workspace_starting", state: st.state, message: statusMessage(st) }, { "retry-after": "2" });
      return proxy(req, res, user.id, e.port);
    }
    if (url.pathname === "/__toiv/starting") return sendGatePage(res, "starting.html");
    if (st.state !== "ready" && (req.headers.accept || "").includes("text/html")) {
      res.writeHead(302, { location: pub("/__toiv/starting?next=") + encodeURIComponent(pub(url.pathname + url.search)), "cache-control": "no-store", "x-accel-buffering": "no" });
      return res.end();
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
