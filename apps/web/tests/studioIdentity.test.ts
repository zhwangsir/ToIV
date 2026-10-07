/**
 * M7 /studio 多租户身份注入单测(node:test)。
 * 覆盖:签名格式与 Go 端(canvas-api SignUserIdentity)逐字节一致 / 路径映射与解码 /
 * 客户端伪造的内部头被删除 / 未配置 key 时只删不签 / STUDIO_MULTITENANT=1 时普通用户放行并注入身份 /
 * 未开启时维持管理员闸 / 交换路由在多租户模式给普通用户发会话。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { _resetStudioGuardCache, decideStudioAccess } from "../lib/studioGuard";
import {
  buildCanvasRequestHeaders,
  canvasUpstreamPath,
  signStudioIdentity,
  studioIdentityKey,
  studioMultiTenantEnabled,
} from "../lib/studioIdentity";

const KEY = "0123456789abcdef0123456789abcdef-test-key";
const USER_ID = "b".repeat(32);
const ADMIN_ID = "a".repeat(32);

test("签名与 Go 端向量一致(apps/canvas/backend user_identity_test.go)", async () => {
  const v = await signStudioIdentity({ key: KEY, uid: USER_ID, role: "user", ts: 1800000000, method: "post", path: "/api/canvas-projects/画布 1" });
  assert.equal(v, "v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.user.1800000000.e2a2034ddab6f2075390bc4dd908f7441d448a0efa9f0c5eebb1825344580f23");
  await assert.rejects(signStudioIdentity({ key: KEY, uid: "../x", role: "user", ts: 1, method: "GET", path: "/api" }));
});

test("路径映射:/studio/api/x → /api/x,并解码;key 过短视为未配置", () => {
  assert.equal(canvasUpstreamPath("/studio/api/canvas-projects/abc"), "/api/canvas-projects/abc");
  assert.equal(canvasUpstreamPath("/studio/api/x/%E7%94%BB%E5%B8%83%201"), "/api/x/画布 1");
  assert.equal(canvasUpstreamPath("/studio/api/bad/%E0%A4%A"), "/api/bad/%E0%A4%A");
  assert.equal(studioIdentityKey({ CANVAS_USER_IDENTITY_KEY: "short" }), "");
  assert.equal(studioIdentityKey({ CANVAS_USER_IDENTITY_KEY: KEY }), KEY);
  assert.equal(studioMultiTenantEnabled({ STUDIO_MULTITENANT: "1" }), true);
  assert.equal(studioMultiTenantEnabled({}), false);
});

test("buildCanvasRequestHeaders:删除客户端伪造的内部头,按真实身份重签", async () => {
  const incoming = new Headers({
    "x-toiv-user": "v1.forged.admin.1.deadbeef",
    "x-beeftv-gate-auth": "v1.x.1.y",
    "x-beeftv-agent-token": "guess",
    accept: "application/json",
  });
  const h = await buildCanvasRequestHeaders(incoming, { id: USER_ID, role: "user" }, { method: "GET", pathname: "/studio/api/assets" }, { CANVAS_USER_IDENTITY_KEY: KEY }, () => 1800000000_000);
  assert.ok(h);
  assert.equal(h.get("x-beeftv-gate-auth"), null);
  assert.equal(h.get("x-beeftv-agent-token"), null);
  assert.equal(h.get("accept"), "application/json");
  const expected = await signStudioIdentity({ key: KEY, uid: USER_ID, role: "user", ts: 1800000000, method: "GET", path: "/api/assets" });
  assert.equal(h.get("x-toiv-user"), expected);
  // 非 admin 角色一律降为 user;未配置 key:只删不签
  const h2 = await buildCanvasRequestHeaders(incoming, { id: USER_ID, role: "owner" }, { method: "GET", pathname: "/studio/api/assets" }, {});
  assert.ok(h2);
  assert.equal(h2.get("x-toiv-user"), null);
  // 不合规 uid:拒绝
  assert.equal(await buildCanvasRequestHeaders(incoming, { id: "a/b", role: "user" }, { method: "GET", pathname: "/studio/api/assets" }, { CANVAS_USER_IDENTITY_KEY: KEY }), null);
});

test("decideStudioAccess:多租户模式放行普通用户,未开启维持管理员闸", () => {
  const user = { kind: "ok" as const, user: { id: USER_ID, role: "user" } };
  assert.deepEqual(decideStudioAccess("/studio/api/assets", user, { multiTenant: true }), { action: "pass" });
  assert.equal(decideStudioAccess("/studio/api/assets", user).action, "json");
  assert.equal(decideStudioAccess("/studio/api/assets", { kind: "invalid" }, { multiTenant: true }).action, "json");
});

function fakeToivFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const tok = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
    if (tok === "admin-token") return Response.json({ user: { id: ADMIN_ID, role: "admin" } });
    if (tok === "user-token") return Response.json({ user: { id: USER_ID, role: "user" } });
    return Response.json({ detail: "expired" }, { status: 401 });
  }) as typeof fetch;
}

test("中间件真实入口(多租户):普通用户放行并注入签名头,伪造头被覆盖,伪造/过期 token 401", async (t) => {
  _resetStudioGuardCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeToivFetch();
  process.env.STUDIO_MULTITENANT = "1";
  process.env.CANVAS_USER_IDENTITY_KEY = KEY;
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.STUDIO_MULTITENANT;
    delete process.env.CANVAS_USER_IDENTITY_KEY;
  });
  const { NextRequest } = await import("next/server");
  const { middleware } = await import("../middleware");
  const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    new NextRequest(new URL(path, "http://127.0.0.1:3100"), { headers, method });

  const r = await middleware(req("/studio/api/canvas-projects", { authorization: "Bearer user-token", "x-toiv-user": "v1.forged.admin.1.00" }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-middleware-next"), "1");
  const overridden = (r.headers.get("x-middleware-override-headers") || "").split(",");
  assert.ok(overridden.includes("x-toiv-user"), "身份头进入 override 列表");
  const injected = r.headers.get("x-middleware-request-x-toiv-user") || "";
  assert.match(injected, new RegExp(`^v1\\.${USER_ID}\\.user\\.\\d+\\.[0-9a-f]{64}$`));

  let bad = await middleware(req("/studio/api/canvas-projects", { authorization: "Bearer forged.jwt.sig" }));
  assert.equal(bad.status, 401);
  bad = await middleware(req("/studio/api/canvas-projects", { "x-toiv-user": "v1.x.admin.1.00" }));
  assert.equal(bad.status, 401, "只带伪造身份头、无 token → 401");

  // 豁免路径也删除内部头
  const ex = await middleware(req("/studio/api/health/live", { "x-toiv-user": "v1.forged.admin.1.00" }));
  assert.equal(ex.headers.get("x-middleware-next"), "1");
  assert.ok(ex.headers.has("x-middleware-override-headers"), "请求头被改写");
  assert.ok(!(ex.headers.get("x-middleware-override-headers") || "").split(",").includes("x-toiv-user"));
  assert.equal(ex.headers.get("x-middleware-request-x-toiv-user"), null);

  const { POST } = await import("../app/studio/auth/exchange/route");
  const xr = await POST(new Request("http://127.0.0.1:3100/studio/auth/exchange", { method: "POST", headers: { authorization: "Bearer user-token" } }));
  assert.equal(xr.status, 200, "多租户模式普通用户也发会话 cookie");
});
