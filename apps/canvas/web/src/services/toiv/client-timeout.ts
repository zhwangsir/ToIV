/**
 * 客户端超时感知（感知版 #13 / P3）：
 * HTTP/axios/轮询等待超时 ≠ Job 已失败。统一文案「仍在后台跑」+ 任务中心入口。
 * 真 Job failed/timeout（后端 status）仍走原失败文案，不经此处改写。
 */
export const TOIV_TASKS_PATH = "/toiv/tasks";

/** 统一用户可见语义（含「去任务中心」指引）。 */
export const CLIENT_TIMEOUT_STILL_RUNNING =
    "请求等待超时，作业仍在后台跑；可到任务中心查看进度";

const AXIOS_TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT", "ERR_TIMEOUT"]);

/** 文案是否应按「仍在跑」展示（info 态 + 去任务中心），而非失败红字。 */
export function isStillRunningMessage(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (t.includes("仍在后台跑") || t.includes("仍在进行")) return true;
    // 「失败 + 可在任务中心看详情」仍是失败，不当成仍在跑
    if (/失败|已取消|已中止/.test(t)) return false;
    if (t.includes("可到任务中心") || t.includes("可在任务中心") || t.includes("ToIV 任务中心")) return true;
    if (t.includes("任务中心查看") || t.includes("任务中心可见") || t.includes("任务中心跟踪")) return true;
    return false;
}

/**
 * 仅识别「客户端等待」类文案，避免把 Job hold_reason / 业务失败误判成仍在跑。
 */
function looksLikeClientTimeoutText(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (t.includes("仍在后台跑") || t.includes("仍在进行")) return true;
    // axios 默认："timeout of 15000ms exceeded"
    if (/timeout of \d+m?s exceeded/i.test(t)) return true;
    // 本仓 apiFetch / XHR 客户端等待
    if (/请求超时|轮询等待超时/i.test(t)) return true;
    // 本仓前端轮询 deadline 旧文案（显式客户端等待，不是 Job.status）
    if (/^(超分超时|拆解超时)/.test(t)) return true;
    return false;
}

/**
 * 是否为「客户端等待超时」错误（axios timeout / 明确客户端超时文案）。
 * 不含：后端 Job status=error/timeout 的业务失败文案。
 */
export function isClientTimeoutError(error: unknown): boolean {
    if (error == null) return false;
    if (typeof error === "string") return looksLikeClientTimeoutText(error);
    if (typeof error !== "object") return false;
    const e = error as { code?: unknown; message?: unknown; name?: unknown };
    // DOMException AbortError 来自用户取消，不当超时
    if (String(e.name ?? "") === "AbortError") return false;
    const code = String(e.code ?? "");
    const message = String(e.message ?? "");
    if (AXIOS_TIMEOUT_CODES.has(code)) {
        // 无 timeout 字样的 ECONNABORTED 可能是其它中断，保守不改写
        if (code === "ECONNABORTED" && message && !/timeout/i.test(message) && !/超时/.test(message)) {
            return false;
        }
        return true;
    }
    return looksLikeClientTimeoutText(message);
}

export function formatClientTimeoutMessage(_opts?: { label?: string }): string {
    return CLIENT_TIMEOUT_STILL_RUNNING;
}

/**
 * catch 后面向用户的一句：客户端超时 → 仍在跑；否则透传 Error.message / fallback。
 */
export function userFacingCaughtError(error: unknown, fallback: string): string {
    if (isClientTimeoutError(error)) return formatClientTimeoutMessage();
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    if (typeof error === "string" && error.trim()) return error.trim();
    return fallback;
}
