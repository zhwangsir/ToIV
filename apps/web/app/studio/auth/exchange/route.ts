// M4-4 Phase C:/studio/auth/exchange 从登录网关(gate)移交 Next。
// 契约与 gate 完全一致:POST + Authorization: Bearer <ToIV JWT> → 校验(toiv-api /api/auth/me)
// → Set-Cookie toiv_session=<JWT>(Path=/studio,HttpOnly,SameSite=Strict,无 Secure——公网 https
// 与 TS 直连 http 双入口同用,与 gate GATE_COOKIE_SECURE=0 决策一致)。
// 该 cookie 供 URL 型访问(img/下载/EventSource 无法带 Authorization)经 canvas-api 的
// cookie 兜底直验使用;fetch 类请求走 SPA 附着的 Bearer。
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

function toivBase(): string {
  return process.env.INTERNAL_API_BASE || process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8090";
}

async function introspect(token: string): Promise<{ id: string; name: string; email: string; role: string } | null> {
  try {
    const r = await fetch(`${toivBase()}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const u = j && (j.user || j);
    if (!u || typeof u.id !== "string" || !/^[a-f0-9]{32}$/.test(u.id)) return null;
    return { id: u.id, name: u.display_name || u.name || u.username || "", email: u.email || "", role: typeof u.role === "string" ? u.role : "" };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return Response.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  const user = await introspect(token);
  if (!user) return Response.json({ error: "unauthenticated", message: "ToIV 登录已失效" }, { status: 401, headers: NO_STORE });
  // 2026-10-08 止血:用户隔离落地前 /studio 只对管理员开放——非管理员不发会话 cookie,
  // 首页探测据此留在经典界面(中间件对 /studio 页面与 /studio/api/* 同样按 admin 拦截)。
  if (user.role !== "admin") {
    return Response.json({ error: "forbidden", reason: "studio_admin_only", message: "画布暂只对管理员开放" }, { status: 403, headers: NO_STORE });
  }
  let maxAge = 7 * 86400;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (payload && typeof payload.exp === "number") maxAge = Math.max(60, payload.exp - Math.floor(Date.now() / 1000));
  } catch {
    // 无法解析过期时间:默认 7 天
  }
  return Response.json(
    { ok: true, user },
    {
      headers: {
        ...NO_STORE,
        "set-cookie": `toiv_session=${encodeURIComponent(token)}; Path=/studio; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
      },
    },
  );
}
