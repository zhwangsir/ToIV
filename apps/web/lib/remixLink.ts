/**
 * 闭门同款(2026-09-21 作品库 P3.5):作品参数编码为分享链接,接收方打开即导入运行台。
 *
 * 隐私设计:只带标量参数(prompt/seed/宽高/步数/采样档等)——媒体句柄(filename/worker)
 * 属内部实现且跨账号无意义,一律剥离;接收方须自己提供参考图/音/视频。
 * 载体:URL ?remix=<base64url(json)>,纯前端,零后端改动、零合规负担(不公开、无广场)。
 */
import type { JobItem } from "./types";

export interface RemixPayload {
  /** 引擎注册表 id(如 h3-t2v);映射不出则为空=仅提示词同款。 */
  e: string;
  /** 提示词。 */
  p: string;
  /** seed(可复现;null=随机)。 */
  s: number | null;
  /** 标量参数(数字/字符串/布尔),媒体键已剥离。 */
  v: Record<string, number | string | boolean>;
}

/** job.kind → 引擎注册表 id(下划线→中划线为主,特例显式映射;映射不出空串)。 */
export function engineIdForKind(kind: string): string {
  const special: Record<string, string> = {
    audio: "ace-music",
    ace_audio: "ace-music",
    txt2video: "txt2img", // wan_t2v 无独立引擎卡,回落文生图(提示词仍可用)
  };
  if (special[kind]) return special[kind];
  const dashed = kind.replace(/_/g, "-");
  return /^[a-z0-9-]+$/.test(dashed) ? dashed : "";
}

/** 剥离媒体/内部键,只留标量(可安全分享)。 */
function sanitizeValues(params: Record<string, unknown>): RemixPayload["v"] {
  const out: RemixPayload["v"] = {};
  const drop = /^(image|images|audio|video|source_|worker|first_frame|last_frame|keyframes)/i;
  for (const [k, val] of Object.entries(params ?? {})) {
    if (drop.test(k)) continue;
    if (typeof val === "number" || typeof val === "boolean") out[k] = val;
    else if (typeof val === "string" && val.length <= 512) out[k] = val;
  }
  return out;
}

export function buildRemixPayload(job: JobItem): RemixPayload {
  // params 快照随列表不返回(仅 has_params 标记);同款标量参数从 meta + seed 够复现主体,
  // 完整参数走「复用提示词/一键同款」路径——分享链接只保证 prompt+seed+引擎+分辨率。
  const params: Record<string, unknown> = { ...(job.meta ?? {}) };
  return {
    e: engineIdForKind(job.kind),
    p: job.prompt ?? "",
    s: typeof job.seed === "number" ? job.seed : null,
    v: sanitizeValues(params),
  };
}

export function encodeRemix(payload: RemixPayload): string {
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeRemix(encoded: string): RemixPayload | null {
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    const p = JSON.parse(json) as Partial<RemixPayload>;
    if (typeof p.p !== "string") return null;
    return {
      e: typeof p.e === "string" ? p.e : "",
      p: p.p,
      s: typeof p.s === "number" ? p.s : null,
      v: p.v && typeof p.v === "object" ? (p.v as RemixPayload["v"]) : {},
    };
  } catch {
    return null;
  }
}

/** 从当前 location 解析 remix 参数并清除 URL(防刷新重复导入/分享时泄露参数)。 */
export function takeRemixFromLocation(): RemixPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search);
    const enc = q.get("remix");
    if (!enc) return null;
    q.delete("remix");
    const qs = q.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
    return decodeRemix(enc);
  } catch {
    return null;
  }
}

/** 分享链接(绝对地址,直接可发)。 */
export function buildRemixLink(job: JobItem, target: "image" | "video" | "audio"): string {
  const base = `${window.location.origin}/?view=${target}`;
  return `${base}&remix=${encodeRemix(buildRemixPayload(job))}`;
}
