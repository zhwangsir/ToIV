/**
 * 市场烟测徽章感知：smoke_status=timeout ≠ 应用不可用。
 * 冒测/客户端等待超时只说明「没在时限内验完」；慢链（SeedVR2 等）尤其如此。
 * 真 fail/error 仍用失败色与失败文案。
 */

/** 与后端 app_smoke._HEAVY_* 对齐的慢链启发（列表卡无 workflow 时用 id/名/描述猜）。 */
const SLOW_CHAIN_MARKERS = [
    "seedvr",
    "flashvsr",
    "rife",
    "wanvideo",
    "wan2",
    "wan_2",
    "ltxv",
    "ltx",
    "hunyuan",
    "hyvideo",
    "cogvideo",
    "mochi",
    "svd_img2vid",
    "llama_cpp",
    "vfi",
] as const;

export type SmokeBadgeTone = "success" | "error" | "warning" | "neutral" | "loading";

export type SmokeBadgeHints = {
    id?: string | null;
    name?: string | null;
    description?: string | null;
    category?: string | null;
    /** 若后端下发 smoke_cls=timeout 等，也可参与判定 */
    smoke_cls?: string | null;
};

export function isLikelySlowChainApp(hints?: SmokeBadgeHints | null): boolean {
    if (!hints) return false;
    const blob = [hints.id, hints.name, hints.description, hints.category, hints.smoke_cls]
        .map((x) => String(x ?? "").toLowerCase())
        .join(" ");
    if (!blob.trim()) return false;
    return SLOW_CHAIN_MARKERS.some((m) => blob.includes(m));
}

/**
 * 用户可见徽章文案。空 / 未知空串 → null（不展示）。
 * timeout → 慢链 / 未验证（慢链）；绝不回落英文 "timeout"。
 */
export function formatSmokeBadgeLabel(
    status?: string | null,
    hints?: SmokeBadgeHints | null,
): string | null {
    const s = String(status ?? "").trim().toLowerCase();
    if (!s) return null;
    if (s === "pass") return "烟测通过";
    if (s === "fail" || s === "error" || s === "smoke_error") return "烟测失败";
    if (s === "running") return "烟测中";
    if (s === "timeout" || s === "timed_out" || s === "timedout") {
        return isLikelySlowChainApp(hints) ? "慢链" : "未验证（慢链）";
    }
    if (s === "untested") return "未验证";
    // 其它未知英文状态：不直接甩给用户
    if (/^[a-z0-9_:-]+$/.test(s)) return "未验证";
    return String(status).trim();
}

/** 徽章色调：timeout 用 warning（警示未验完），不用 error（暗示不能跑）。 */
export function smokeBadgeTone(status?: string | null): SmokeBadgeTone {
    const s = String(status ?? "").trim().toLowerCase();
    if (s === "pass") return "success";
    if (s === "fail" || s === "error" || s === "smoke_error") return "error";
    if (s === "running") return "loading";
    if (s === "timeout" || s === "timed_out" || s === "timedout") return "warning";
    return "neutral";
}
