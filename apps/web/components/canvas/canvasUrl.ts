/**
 * 画布 iframe 地址决策(2026-08-30 画布公网不可用根治,纯逻辑模块,node:test 可测)。
 *
 * 背景:公网 HTTPS 域名下 iframe 直连 http://IP:8188 被浏览器混合内容拦截,
 * 架构性不可用;此时改走同源 /api/canvas/proxy(后端反向代理 ComfyUI,目标地址
 * 仅取服务端配置 TOIV_CANVAS_COMFY_URL,鉴权复用 JWT ?token= 查询参数)。
 *
 * 策略:
 * - HTTP 页面(局域网/Tailscale 直连本站):保持既有 Tailscale → LAN 直连探测顺序;
 * - HTTPS 页面:http:// 候选必被拦截,全部剔除;无一幸存 → 同源代理;
 * - 显式配置了 https:// 候选(如自带 TLS 的反代)时仍优先直连,不走代理。
 */

/** ComfyUI 画布地址:默认 Tailscale(跨地域唯一可靠路径),LAN 作回退候选。 */
export const COMFYUI_URL =
  process.env.NEXT_PUBLIC_COMFYUI_WEB_URL || "http://100.68.100.90:8188";
/** 同地局域网回退候选(仅默认地址未显式覆盖时参与探测) */
export const COMFYUI_URL_LAN = "http://192.168.71.127:8188";
/** 同源代理路径(后端 GET/POST /api/canvas/proxy → ComfyUI) */
export const CANVAS_PROXY_PATH = "/api/canvas/proxy";

/** 候选列表:自定义地址优先,Tailscale → LAN 兜底(与直连时代顺序一致)。 */
export function buildCandidates(custom: string | null): string[] {
  const base = [COMFYUI_URL, COMFYUI_URL_LAN];
  return custom && !base.includes(custom) ? [custom, ...base] : base;
}

/** HTTPS 页面下,http:// 候选会被浏览器混合内容拦截(探测与 iframe 加载都过不去)。 */
export function isMixedContentBlocked(pageProtocol: string, url: string): boolean {
  return pageProtocol === "https:" && url.startsWith("http://");
}

export type CanvasSrcPlan =
  | { mode: "direct"; candidates: string[] }
  | { mode: "proxy"; src: string };

/**
 * 决策 iframe 源:
 * - 存在不被混合内容拦截的候选 → direct(按原顺序探测);
 * - HTTPS 页面且候选全为 HTTP → proxy(同源 /api/canvas/proxy)。
 */
export function planCanvasSrc(
  pageProtocol: string,
  candidates: string[],
): CanvasSrcPlan {
  const direct = candidates.filter((u) => !isMixedContentBlocked(pageProtocol, u));
  if (direct.length > 0) return { mode: "direct", candidates: direct };
  return { mode: "proxy", src: CANVAS_PROXY_PATH };
}

/**
 * 同源代理路径附带 JWT(<iframe>/<script>/fetch 子资源无法带 Authorization 头,
 * 复用后端 get_current_user 的 ?token= 通道);直连地址不动(ComfyUI 不鉴权)。
 */
export function withToken(src: string, token: string | null): string {
  if (!token || !src.startsWith("/")) return src;
  return `${src}${src.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}
