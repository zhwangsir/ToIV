import type { AssetReconciliationGroup, ReconcileDecision } from "@/services/api/projects";

/**
 * 跨集资产对账的纯逻辑层：漂移/匹配/回执的可读标签，以及
 * 「每个实体一条 pending 决策」的批次构造。不做任何评分或时间戳推断，
 * 匹配结论完全来自后端确定性的名称/别名结果。
 */

export const ASSET_DRIFT_KIND_LABELS: Record<string, string> = {
    shot_missing_reference: "镜头缺少资产引用",
    reference_version_behind_primary: "引用版本落后主版本",
    asset_multi_version_reference: "跨集多版本引用",
    stale_artifact: "产物已失效待重渲",
    character_reference_missing_representation: "角色缺少定妆表现",
    reference_asset_unlinked: "引用资产已不在项目",
};

export function assetDriftKindLabel(kind: string) {
    return ASSET_DRIFT_KIND_LABELS[kind] || kind;
}

export const SUGGESTION_MATCH_LABELS: Record<string, string> = {
    resolved: "已有归并结果",
    asset_name: "名称一致",
    asset_alias: "别名一致",
    none: "无同名资产",
};

export function suggestionMatchLabel(match: string) {
    return SUGGESTION_MATCH_LABELS[match] || match;
}

export const RECONCILE_OUTCOME_LABELS: Record<string, string> = {
    applied: "已应用",
    already_confirmed: "此前已确认",
    auto_linked: "同实体其他集已自动归并",
};

export function reconcileOutcomeLabel(outcome: string) {
    return RECONCILE_OUTCOME_LABELS[outcome] || outcome;
}

export const RECONCILE_CANDIDATE_STATUS_LABELS: Record<string, string> = {
    confirmed: "已确认",
    pending_confirmation: "待确认",
    ignored: "已忽略",
};

export function reconcileCandidateStatusLabel(status: string) {
    return RECONCILE_CANDIDATE_STATUS_LABELS[status] || status;
}

/** 后端单批最多 50 条归并决策；超过必须安全分批，不能整批去撞上限。 */
export const RECONCILE_APPLY_MAX_DECISIONS = 50;

export function chunkReconcileDecisions(decisions: ReconcileDecision[]): ReconcileDecision[][] {
    if (!decisions.length) return [];
    const batches: ReconcileDecision[][] = [];
    for (let index = 0; index < decisions.length; index += RECONCILE_APPLY_MAX_DECISIONS) {
        batches.push(decisions.slice(index, index + RECONCILE_APPLY_MAX_DECISIONS));
    }
    return batches;
}

/** 合并目标只允许同分类资产：跨分类合并会被后端拒绝，前端不提供无效选项。 */
export function assetsMatchingCategory<T extends { category: string }>(assets: T[], category: string): T[] {
    return assets.filter((asset) => asset.category === category);
}

/** 漂移深链：有 unitId 才能落到章工作区；shotId 作为 query 供镜头定位。 */
export function chapterShotHref(projectId: string, unitId: string, shotId?: string): string {
    if (!projectId || !unitId) return "";
    const base = `/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(unitId)}`;
    return shotId ? `${base}?shot=${encodeURIComponent(shotId)}` : base;
}

export type ReconcileDecisionDraft = { action: "merge" | "create"; assetId?: string };

/** 已全部 confirmed 的实体组不必显示。 */
export function isCandidateGroupComplete(group: AssetReconciliationGroup) {
    return group.appearances.length > 0 && group.appearances.every((appearance) => appearance.status === "confirmed");
}

/** 实体组的决策落点：第一条 pending 候选；同实体其他集由服务端 auto_linked。 */
export function pendingDecisionCandidateId(group: AssetReconciliationGroup) {
    return group.appearances.find((appearance) => appearance.status === "pending_confirmation")?.candidateId || "";
}

export function defaultReconcileDecision(group: AssetReconciliationGroup): ReconcileDecisionDraft {
    if (group.suggestion.action === "create") return { action: "create" };
    return { action: "merge", assetId: group.suggestion.assetId };
}

export function resolveReconcileDecision(group: AssetReconciliationGroup, overrides: Record<string, ReconcileDecisionDraft>): ReconcileDecisionDraft {
    return overrides[group.key] || defaultReconcileDecision(group);
}

export function isCompleteDecision(draft: ReconcileDecisionDraft) {
    return draft.action === "create" || Boolean(draft.assetId);
}

/** 改判后仍缺目标资产的实体组，用于拦截「全部确认」。 */
export function incompleteReconcileGroupKeys(groups: AssetReconciliationGroup[], overrides: Record<string, ReconcileDecisionDraft>) {
    return groups
        .filter((group) => pendingDecisionCandidateId(group) && !isCompleteDecision(resolveReconcileDecision(group, overrides)))
        .map((group) => group.key);
}

/** 每个实体只提交一条 pending 决策；无 pending 或决策不完整的组不进批次。 */
export function buildReconcileDecisions(groups: AssetReconciliationGroup[], overrides: Record<string, ReconcileDecisionDraft>): ReconcileDecision[] {
    const decisions: ReconcileDecision[] = [];
    for (const group of groups) {
        const candidateId = pendingDecisionCandidateId(group);
        if (!candidateId) continue;
        const draft = resolveReconcileDecision(group, overrides);
        if (!isCompleteDecision(draft)) continue;
        if (draft.action === "create") {
            decisions.push({ candidateId, action: "create" });
            continue;
        }
        decisions.push({ candidateId, action: "merge", assetId: draft.assetId! });
    }
    return decisions;
}
