/**
 * F11(2026-10-15):媒体转录「台词检索」服务面。
 *
 * 后端=FU2 落的 FastAPI 管理端点 GET /api/admin/media/transcripts/search
 * (apps/api/app/routes/film_edit.py;get_current_admin 门禁),响应为**裸 dict**
 * {q, results:[{media_url, duration_sec, source_tag, hits[]}]}——不是 {code,data,msg} 信封,
 * 也不经画布 Go 后端。走 toivHttp(同源 /api + toiv_token)。
 *
 * P-11 形状门:非 200 由 axios 抛错;200 但形状异常(如 Next 兜底的 HTML 壳、错误页)
 * 必须抛错,禁止静默返回 [] 把「检索坏了」伪装成「没有台词命中」。
 */
import { toivHttp } from "./client";

/** 单条命中媒体:hits 为 packed_md 里带 [start-end] 时间轴的命中短语行(后端截前 8 条)。 */
export type ToivTranscriptHit = {
    media_url: string;
    duration_sec: number;
    /** whisper 链路来源标签(cluster/local/fallback 等;后端可空) */
    source_tag: string;
    hits: string[];
};

export type TranscriptSearchOpts = {
    limit?: number;
    signal?: AbortSignal;
};

function normalizeHit(raw: unknown): ToivTranscriptHit {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
        media_url: typeof r.media_url === "string" ? r.media_url : "",
        duration_sec: Number(r.duration_sec) || 0,
        source_tag: typeof r.source_tag === "string" ? r.source_tag : "",
        hits: Array.isArray(r.hits) ? r.hits.map((h) => String(h)) : [],
    };
}

/** 台词检索:q 为空(纯空白)不发请求直接 []（后端同口径);其余异常一律上抛(P-11)。 */
export async function searchMediaTranscripts(
    q: string,
    opts: TranscriptSearchOpts = {},
): Promise<ToivTranscriptHit[]> {
    const needle = (q || "").trim();
    if (!needle) return [];
    const { data } = await toivHttp.get("/admin/media/transcripts/search", {
        params: { q: needle, limit: opts.limit ?? 20 },
        timeout: 30_000,
        signal: opts.signal,
    });
    if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
        throw new Error("台词检索响应形状异常(非 {results:[]} 对象)");
    }
    return (data as { results: unknown[] }).results.map(normalizeHit);
}

/** 面板可见性口径:仅 admin(后端 get_current_admin 同款判据,前端只做展示门禁,不做安全门禁)。 */
export function isTranscriptSearchAvailable(role: string | null | undefined): boolean {
    return role === "admin";
}

/** 现有账号会话面=ToIV /api/auth/me(auth.py 返回 {user:{…,role},usage});
 *  未登录/网络失败返回 null(UI 隐藏面板,不弹错)。 */
export async function fetchToivAccountRole(): Promise<string | null> {
    try {
        const { data } = await toivHttp.get("/auth/me", { timeout: 10_000 });
        const role = (data as { user?: { role?: unknown } })?.user?.role;
        return typeof role === "string" ? role : null;
    } catch {
        return null;
    }
}
