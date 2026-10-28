import type { ToivDramaShot, ToivRenderEstimate, ToivStageId } from "@/services/toiv/client";

export type RenderEstimateViewState = {
    loading: boolean;
    error: string | null;
    estimate: ToivRenderEstimate | null;
};

export function canConfirmRenderEstimate(state: RenderEstimateViewState): boolean {
    return !state.loading && !state.error && state.estimate?.allowed === true;
}

export function renderEstimatePricing(estimate: ToivRenderEstimate): {
    unpriced: boolean;
    totalLabel: string;
    note: string;
    budgetLabel: string;
    budgetExceeded: boolean;
} {
    const unpriced = estimate.pricing.status === "unpriced";
    const totalLabel = unpriced || estimate.pricing.total === null
        ? "未配置费率"
        : `${estimate.pricing.total}${estimate.pricing.currency ? ` ${estimate.pricing.currency}` : ""}`;
    const unknowns = estimate.pricing.unknowns.filter(Boolean);
    const note = unpriced
        ? `未配置费率，不代表免费${unknowns.length ? `；未知项：${unknowns.join("、")}` : ""}`
        : unknowns.length
            ? `部分价格未知：${unknowns.join("、")}`
            : "预估金额以服务端费率与候选上限计算";
    const budget = estimate.budget;
    const budgetStatus = budget.status === "exceeded"
        ? "预算超限"
        : budget.status === "within"
            ? "预算内"
            : budget.status === "disabled"
                ? "未启用预算"
                : "预算待定价";
    const budgetLabel = `${budgetStatus}${budget.limit !== null ? ` · 上限 ${budget.limit}${budget.currency ? ` ${budget.currency}` : ""}` : ""}`;
    return { unpriced, totalLabel, note, budgetLabel, budgetExceeded: budget.status === "exceeded" };
}

export function renderEstimateError(error: unknown): string {
    const detail = (error as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
    if (typeof detail === "string") return detail;
    return error instanceof Error ? error.message : "成本预估失败";
}

export function renderEstimateErrorStage(error: unknown): ToivStageId | null {
    const response = (error as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
    const detail = response?.data?.detail;
    if (response?.status !== 409 || typeof detail !== "string" || !detail.includes("STAGE_REQUIRED")) return null;
    const stages: ToivStageId[] = ["script", "assets", "storyboard", "generate", "voice", "timeline"];
    return stages.find((stage) => detail.includes(stage)) ?? null;
}

export function hasUnsavedShotChanges(
    shot: ToivDramaShot,
    editing: { field: "prompt" | "dialogue"; draft: string } | null,
    durationSec?: Record<string, number>,
    seamToNext?: Record<string, string>,
): boolean {
    if (editing && editing.draft !== String(shot[editing.field] ?? "")) return true;
    const duration = durationSec?.[shot.id];
    if (duration !== undefined && duration !== (shot.duration_sec ?? 6)) return true;
    const seam = seamToNext?.[shot.id];
    return seam !== undefined && seam !== (shot.seam_to_next ?? "hardcut");
}
