/**
 * /studio 多租户身份注入(M7 用户隔离)。
 *
 * Next 中间件在内省 ToIV JWT(lib/studioGuard.ts)之后,为转发到 canvas-api 的 /studio/api/*
 * 请求注入一个签名身份头,canvas-api 以此决定「这是谁的工作区」:
 *
 *   X-ToIV-User: v1.<uid>.<role>.<unix 秒>.<hex HMAC-SHA256>
 *   MAC = HMAC(key, "toiv-user\nv1\n<uid>\n<role>\n<unix>\n<METHOD>\n<canvas-api 看到的解码路径>")
 *
 * · key 与 canvas-api 的 CANVAS_USER_IDENTITY_KEY_FILE 同一份(≥32 字节),这里从环境变量
 *   CANVAS_USER_IDENTITY_KEY 读取(toiv-web 的 0600 EnvironmentFile),绝不进日志/前端包;
 * · 客户端自带的 X-ToIV-User / X-Beeftv-Gate-Auth / 助手宿主头一律先删除,浏览器无法伪造身份;
 * · canvas-api 只接受来自本机/内网代理(CANVAS_TRUSTED_PROXY_CIDRS)的该头,±60s,绑定方法与路径,
 *   直连请求(无签名头)一律 401。
 *
 * 只用 Web Crypto,edge 与 node 运行时都可用。
 */

export const STUDIO_IDENTITY_HEADER = "x-toiv-user";

/** 浏览器不得自带、必须由服务端决定的内部头。 */
export const STUDIO_INTERNAL_HEADERS = [
  STUDIO_IDENTITY_HEADER,
  "x-beeftv-gate-auth",
  "x-beeftv-agent-token",
  "x-beeftv-agent-turn",
  "x-beeftv-owner",
] as const;

const UID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;
const MIN_KEY_BYTES = 32;

export type StudioIdentityEnv = {
  STUDIO_MULTITENANT?: string;
  CANVAS_USER_IDENTITY_KEY?: string;
};

/** STUDIO_MULTITENANT=1:canvas-api 已按用户隔离,/studio 对所有有效 ToIV 账号开放(取代管理员止血闸)。 */
export function studioMultiTenantEnabled(env: StudioIdentityEnv): boolean {
  return (env.STUDIO_MULTITENANT || "").trim() === "1";
}

export function studioIdentityKey(env: StudioIdentityEnv): string {
  const key = (env.CANVAS_USER_IDENTITY_KEY || "").trim();
  return new TextEncoder().encode(key).length >= MIN_KEY_BYTES ? key : "";
}

/** /studio/api/x → /api/x(与 next.config beforeFiles rewrite 一致),并按 canvas-api 的 r.URL.Path 解码。 */
export function canvasUpstreamPath(pathname: string): string {
  const raw = pathname.startsWith("/studio/") ? pathname.slice("/studio".length) : pathname;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function studioRole(role: string): "admin" | "user" {
  return role === "admin" ? "admin" : "user";
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signStudioIdentity(opts: {
  key: string;
  uid: string;
  role: "admin" | "user";
  ts: number;
  method: string;
  path: string;
}): Promise<string> {
  if (!UID_PATTERN.test(opts.uid)) throw new Error("invalid uid");
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(opts.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const path = opts.path.split("?")[0] || "/";
  const msg = `toiv-user\nv1\n${opts.uid}\n${opts.role}\n${opts.ts}\n${opts.method.toUpperCase()}\n${path}`;
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return `v1.${opts.uid}.${opts.role}.${opts.ts}.${toHex(mac)}`;
}

/**
 * 生成转发给 canvas-api 的请求头:删除所有内部头,再(配置了 key 时)注入签名身份。
 * 返回 null 表示 uid 不合规,调用方应拒绝请求。
 */
export async function buildCanvasRequestHeaders(
  incoming: Headers,
  user: { id: string; role: string },
  req: { method: string; pathname: string },
  env: StudioIdentityEnv,
  now: () => number = Date.now,
): Promise<Headers | null> {
  const headers = new Headers(incoming);
  for (const name of STUDIO_INTERNAL_HEADERS) headers.delete(name);
  const key = studioIdentityKey(env);
  if (!key) return headers;
  if (!UID_PATTERN.test(user.id)) return null;
  headers.set(
    STUDIO_IDENTITY_HEADER,
    await signStudioIdentity({
      key,
      uid: user.id,
      role: studioRole(user.role),
      ts: Math.floor(now() / 1000),
      method: req.method,
      path: canvasUpstreamPath(req.pathname),
    }),
  );
  return headers;
}
