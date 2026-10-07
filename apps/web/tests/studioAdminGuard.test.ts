/**
 * /studio 管理员闸(2026-10-08 止血)单测(node:test,无 DOM)。
 * 覆盖:token 提取(Bearer 优先、cookie 兜底)/ 内省结论(admin、普通用户、401 伪造过期、
 * 5xx 与网络错误 → error)/ 正向缓存 60s、负向不缓存 / 路径分类(豁免、静态文件、API、SPA)/
 * 中间件真实入口(next/server NextRequest)对 /studio/api/* 返回 401/403/503 与放行、
 * SPA 页面跳经典界面或首页 / 交换路由对非管理员 403 且不发 cookie。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetStudioGuardCache,
  CLASSIC_HOME,
  decideStudioAccess,
  extractStudioToken,
  introspectStudioUser,
  isStudioStaticFile,
  LOGIN_HOME,
  STUDIO_CACHE_TTL_MS,
} from "../lib/studioGuard";

const ADMIN_ID = "a".repeat(32);
const USER_ID = "b".repeat(32);

/** 假 toiv-api:admin-token → admin;user-token → user;down-token → 502;throw-token → 网络错误;其他 → 401。 */
function fakeToivFetch(calls: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") || "";
    const tok = auth.replace(/^Bearer /, "");
    calls.push(tok);
    if (tok === "throw-token") throw new TypeError("fetch failed");
    if (tok === "down-token") return new Response("bad gateway", { status: 502 });
    if (tok === "admin-token") {
      return Response.json({ user: { id: ADMIN_ID, email: "admin", role: "admin" } });
    }
    if (tok === "user-token") {
      return Response.json({ user: { id: USER_ID, email: "u1", role: "user" } });
    }
    return Response.json({ detail: "会话已过期" }, { status: 401 });
  }) as typeof fetch;
}

test("extractStudioToken:Bearer 优先,其次 toiv_session cookie(URL 解码),都没有为空", () => {
  assert.equal(extractStudioToken("Bearer abc", "toiv_session=zzz"), "abc");
  assert.equal(extractStudioToken(null, "x=1; toiv_session=a%2Eb%2Ec; y=2"), "a.b.c");
  assert.equal(extractStudioToken("Basic xx", "other=1"), "");
  assert.equal(extractStudioToken(null, null), "");
});

test("introspectStudioUser:admin / 普通用户 / 伪造过期 / 上游故障", async () => {
  _resetStudioGuardCache();
  const calls: string[] = [];
  const f = fakeToivFetch(calls);
  const base = "http://toiv.test";
  assert.deepEqual(await introspectStudioUser("admin-token", { base, fetchImpl: f }), { kind: "ok", user: { id: ADMIN_ID, role: "admin" } });
  assert.deepEqual(await introspectStudioUser("user-token", { base, fetchImpl: f }), { kind: "ok", user: { id: USER_ID, role: "user" } });
  assert.deepEqual(await introspectStudioUser("forged.jwt.sig", { base, fetchImpl: f }), { kind: "invalid" });
  assert.deepEqual(await introspectStudioUser("down-token", { base, fetchImpl: f }), { kind: "error" });
  assert.deepEqual(await introspectStudioUser("throw-token", { base, fetchImpl: f }), { kind: "error" });
  assert.deepEqual(await introspectStudioUser("", { base, fetchImpl: f }), { kind: "invalid" });
  assert.deepEqual(await introspectStudioUser("x".repeat(5000), { base, fetchImpl: f }), { kind: "invalid" });
});

test("introspectStudioUser:正向结论缓存 60s,过期重查;负向不缓存", async () => {
  _resetStudioGuardCache();
  const calls: string[] = [];
  const f = fakeToivFetch(calls);
  let now = 1_000_000;
  const opts = { base: "http://toiv.test", fetchImpl: f, now: () => now };
  await introspectStudioUser("admin-token", opts);
  await introspectStudioUser("admin-token", opts);
  assert.equal(calls.filter((c) => c === "admin-token").length, 1);
  now += STUDIO_CACHE_TTL_MS + 1;
  await introspectStudioUser("admin-token", opts);
  assert.equal(calls.filter((c) => c === "admin-token").length, 2);
  await introspectStudioUser("bad", opts);
  await introspectStudioUser("bad", opts);
  assert.equal(calls.filter((c) => c === "bad").length, 2);
});

test("路径分类:静态文件放行、API 与 SPA 深链受闸", () => {
  assert.equal(isStudioStaticFile("/studio/assets/index-abc.js"), true);
  assert.equal(isStudioStaticFile("/studio/short-drama-styles/ink-narrative.jpg"), true);
  assert.equal(isStudioStaticFile("/studio/index.html"), false);
  assert.equal(isStudioStaticFile("/studio/canvas/123"), false);
  assert.equal(isStudioStaticFile("/studio/api/files/a.png"), false);
});

test("decideStudioAccess:API 401/403/503 与放行;SPA 跳转;豁免路径放行", () => {
  const admin = { kind: "ok", user: { id: ADMIN_ID, role: "admin" } } as const;
  const user = { kind: "ok", user: { id: USER_ID, role: "user" } } as const;
  assert.deepEqual(decideStudioAccess("/studio/api/canvases", admin), { action: "pass" });
  assert.equal((decideStudioAccess("/studio/api/canvases", user) as { status: number }).status, 403);
  assert.equal((decideStudioAccess("/studio/api/canvases", { kind: "invalid" }) as { status: number }).status, 401);
  assert.equal((decideStudioAccess("/studio/api/canvases", null) as { status: number }).status, 401);
  assert.equal((decideStudioAccess("/studio/api/canvases", { kind: "error" }) as { status: number }).status, 503);
  assert.deepEqual(decideStudioAccess("/studio", admin), { action: "pass" });
  assert.deepEqual(decideStudioAccess("/studio/", user), { action: "redirect", location: CLASSIC_HOME });
  assert.deepEqual(decideStudioAccess("/studio/canvas/1", null), { action: "redirect", location: LOGIN_HOME });
  for (const p of ["/studio/entry.json", "/studio/auth/exchange", "/studio/auth/logout", "/studio/api/health/live", "/studio/assets/a.js"]) {
    assert.deepEqual(decideStudioAccess(p, null), { action: "pass" }, p);
  }
  assert.deepEqual(decideStudioAccess("/api/auth/me", null), { action: "pass" });
});

test("中间件真实入口:/studio/api/* 与 /studio 页面按 admin 拦截", async (t) => {
  _resetStudioGuardCache();
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeToivFetch(calls);
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { NextRequest } = await import("next/server");
  const { middleware } = await import("../middleware");
  const req = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(new URL(path, "http://127.0.0.1:3100"), { headers });

  let r = await middleware(req("/studio/api/canvases", { authorization: "Bearer admin-token" }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-middleware-next"), "1");

  r = await middleware(req("/studio/api/canvases", { authorization: "Bearer user-token" }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).reason, "studio_admin_only");

  r = await middleware(req("/studio/api/canvases", { authorization: "Bearer forged.jwt.sig" }));
  assert.equal(r.status, 401);
  assert.equal((await r.json()).reason, "toiv_identity_required");

  r = await middleware(req("/studio/api/canvases"));
  assert.equal(r.status, 401);

  r = await middleware(req("/studio/api/canvases", { cookie: "toiv_session=user-token" }));
  assert.equal(r.status, 403);

  r = await middleware(req("/studio/api/canvases", { authorization: "Bearer down-token" }));
  assert.equal(r.status, 503);

  r = await middleware(req("/studio/", { cookie: "toiv_session=admin-token" }));
  assert.equal(r.headers.get("x-middleware-next"), "1");

  r = await middleware(req("/studio/", { cookie: "toiv_session=user-token" }));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), CLASSIC_HOME);

  r = await middleware(req("/studio/canvas/abc"));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), LOGIN_HOME);

  const before = calls.length;
  r = await middleware(req("/studio/assets/index.js"));
  assert.equal(r.headers.get("x-middleware-next"), "1");
  r = await middleware(req("/studio/entry.json"));
  assert.equal(r.headers.get("x-middleware-next"), "1");
  assert.equal(calls.length, before, "静态文件与入口探测不内省");
});

test("交换路由:管理员发 cookie;普通用户 403 不发 cookie;伪造 401", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeToivFetch([]);
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { POST } = await import("../app/studio/auth/exchange/route");
  const post = (tok: string) =>
    POST(new Request("http://127.0.0.1:3100/studio/auth/exchange", { method: "POST", headers: { authorization: `Bearer ${tok}` } }));

  let r = await post("admin-token");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie") || "", /^toiv_session=admin-token; Path=\/studio; HttpOnly/);

  r = await post("user-token");
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal((await r.json()).reason, "studio_admin_only");

  r = await post("forged.jwt.sig");
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);
});
