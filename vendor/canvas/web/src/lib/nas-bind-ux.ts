/** NAS 选模替换动效 / 进度条文案（与后端 stages 对齐，不做分类重做）。 */

export const NAS_BIND_STAGE_ORDER = ["validate", "refresh/bind", "done"] as const;

export type NasBindStageId = (typeof NAS_BIND_STAGE_ORDER)[number] | string;

const STAGE_LABELS: Record<string, string> = {
    validate: "校验路径",
    "refresh/bind": "写入绑定并刷新",
    done: "完成",
    error: "失败",
};

export function nasBindStageLabel(stage: string | undefined | null): string {
    const key = String(stage || "").trim();
    if (!key) return "等待";
    return STAGE_LABELS[key] || key;
}

export function basenameFromRel(rel?: string | null): string {
    const raw = String(rel || "").trim().replace(/\\/g, "/");
    if (!raw) return "";
    const parts = raw.split("/").filter(Boolean);
    return parts[parts.length - 1] || raw;
}

/** 已有绑定且另选了不同权重 → 显示替换条。 */
export function isNasSwapPending(selected?: string | null, bound?: string | null): boolean {
    const s = String(selected || "").trim();
    const b = String(bound || "").trim();
    return Boolean(s && b && s !== b);
}

export function nasBindProgressStatus(opts: {
    stage?: string | null;
    status?: string | null;
    percent?: number | null;
}): "success" | "exception" | "active" | "normal" {
    if (opts.status === "error" || opts.stage === "error") return "exception";
    if (opts.stage === "done" || opts.status === "done" || (opts.percent ?? 0) >= 100) return "success";
    if ((opts.percent ?? 0) > 0 || opts.stage) return "active";
    return "normal";
}

/** 步骤态：pending | current | done | error */
export function nasBindStepState(
    step: string,
    opts: { stage?: string | null; status?: string | null },
): "pending" | "current" | "done" | "error" {
    if (opts.status === "error" || opts.stage === "error") {
        const order = NAS_BIND_STAGE_ORDER as readonly string[];
        const cur = opts.stage === "error" ? "refresh/bind" : String(opts.stage || "");
        const curIdx = order.indexOf(cur);
        const stepIdx = order.indexOf(step);
        if (stepIdx < 0) return "pending";
        if (stepIdx < curIdx) return "done";
        if (stepIdx === curIdx || (curIdx < 0 && step === "validate")) return "error";
        return "pending";
    }
    const order = NAS_BIND_STAGE_ORDER as readonly string[];
    const stage = String(opts.stage || "validate");
    const curIdx = order.indexOf(stage === "done" ? "done" : stage);
    const stepIdx = order.indexOf(step);
    if (stepIdx < 0) return "pending";
    if (stage === "done" || opts.status === "done") return "done";
    if (curIdx < 0) return stepIdx === 0 ? "current" : "pending";
    if (stepIdx < curIdx) return "done";
    if (stepIdx === curIdx) return "current";
    return "pending";
}
