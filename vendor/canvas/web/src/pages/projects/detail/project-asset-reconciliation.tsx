import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Select } from "antd";
import { GitMerge, Layers3, Plus, Sparkles, Split, Wand2 } from "lucide-react";
import { Link } from "react-router";

import { Callout } from "@/components/ui/product/callout";
import { WorkspaceState } from "@/components/layout/workspace-state";
import {
    applyProjectAssetReconciliationDecisions,
    getProjectAssetReconciliation,
    listProjectAssets,
    type AssetReconciliationGroup,
    type ReconcileApplyOutcome,
    type ReconcileDecision,
} from "@/services/api/projects";
import {
    assetDriftKindLabel,
    assetsMatchingCategory,
    buildReconcileDecisions,
    chapterShotHref,
    chunkReconcileDecisions,
    incompleteReconcileGroupKeys,
    isCandidateGroupComplete,
    RECONCILE_APPLY_MAX_DECISIONS,
    reconcileCandidateStatusLabel,
    reconcileOutcomeLabel,
    resolveReconcileDecision,
    suggestionMatchLabel,
    type ReconcileDecisionDraft,
} from "@/lib/asset-reconciliation";

import { categoryLabel } from "./shared";

type ReceiptSnapshot = { names: Map<string, string>; assets: Map<string, string> };

/** 分批写入失败：已落库的批次回执必须带回，不能整轮丢掉。 */
class ReconcileBatchFailure extends Error {
    readonly applied: ReconcileApplyOutcome[];
    readonly batchIndex: number;
    readonly batchCount: number;

    constructor(message: string, applied: ReconcileApplyOutcome[], batchIndex: number, batchCount: number) {
        super(message);
        this.name = "ReconcileBatchFailure";
        this.applied = applied;
        this.batchIndex = batchIndex;
        this.batchCount = batchCount;
    }
}

async function runReconcileApplyBatches(projectId: string, decisions: ReconcileDecision[]) {
    const batches = chunkReconcileDecisions(decisions);
    const results: ReconcileApplyOutcome[] = [];
    let replayed = false;
    for (let index = 0; index < batches.length; index += 1) {
        try {
            const part = await applyProjectAssetReconciliationDecisions(projectId, batches[index]);
            results.push(...part.results);
            replayed = replayed || part.replayed;
        } catch (error) {
            const detail = error instanceof Error ? error.message : "归并确认失败";
            const message = batches.length > 1 ? `第 ${index + 1}/${batches.length} 批归并失败：${detail}` : detail;
            throw new ReconcileBatchFailure(message, results, index + 1, batches.length);
        }
    }
    return { results, replayed };
}

/** 合并目标只列同分类资产；建议目标不在项目列表时补一项（后端建议本身已按分类匹配）。 */
function mergeTargetOptions(group: AssetReconciliationGroup, assets: Array<{ id: string; title: string; category: string }>) {
    const sameCategory = assetsMatchingCategory(assets, group.category);
    const options = sameCategory.map((asset) => ({ value: asset.id, label: asset.title }));
    if (group.suggestion.assetId && !sameCategory.some((asset) => asset.id === group.suggestion.assetId)) {
        options.unshift({ value: group.suggestion.assetId, label: group.suggestion.assetTitle || group.suggestion.assetId });
    }
    return options;
}

/**
 * 跨集资产对账面板：逐集资产版本清单 + 漂移台账 + 候选实体归并决策。
 * 匹配结论来自后端确定性的名称/别名结果，UI 只提供 merge/create 行内改判，
 * 不展示任何推断出来的评分或时间戳。
 */
export function ProjectAssetReconciliationPanel({ projectId }: { projectId: string }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [drafts, setDrafts] = useState<Record<string, ReconcileDecisionDraft>>({});
    const [receipts, setReceipts] = useState<ReconcileApplyOutcome[]>([]);
    const [receiptSnapshot, setReceiptSnapshot] = useState<ReceiptSnapshot>({ names: new Map(), assets: new Map() });
    const [applyError, setApplyError] = useState("");

    const reconciliationQuery = useQuery({
        queryKey: ["project", projectId, "asset-reconciliation"],
        queryFn: () => getProjectAssetReconciliation(projectId),
    });
    const assetsQuery = useQuery({
        queryKey: ["project", projectId, "reconcile-target-assets"],
        queryFn: () => listProjectAssets(projectId),
    });

    const data = reconciliationQuery.data;
    const units = useMemo(() => data?.units || [], [data]);
    const drifts = useMemo(() => data?.drifts || [], [data]);
    const identityGroups = useMemo(() => data?.candidateIdentities || [], [data]);
    const groups = useMemo(() => identityGroups.filter((group) => !isCandidateGroupComplete(group)), [identityGroups]);
    const unitTitleById = useMemo(() => new Map(units.map((unit) => [unit.unitId, unit.unitTitle])), [units]);
    const targetAssets = useMemo(
        () => (assetsQuery.data?.assets || []).slice().sort((left, right) => left.title.localeCompare(right.title, "zh-Hans-CN")),
        [assetsQuery.data],
    );
    const assetTitleById = useMemo(() => {
        const map = new Map(targetAssets.map((asset) => [asset.id, asset.title]));
        for (const unit of units) {
            for (const entry of unit.entries) {
                if (!map.has(entry.assetId)) map.set(entry.assetId, entry.title);
            }
        }
        return map;
    }, [targetAssets, units]);
    const nameByCandidateId = useMemo(() => {
        const map = new Map<string, string>();
        for (const group of identityGroups) {
            for (const appearance of group.appearances) map.set(appearance.candidateId, group.name);
        }
        return map;
    }, [identityGroups]);

    const hasInventory = units.some((unit) => unit.entries.length > 0);
    const isEmpty = reconciliationQuery.isSuccess && !hasInventory && drifts.length === 0 && groups.length === 0;
    const incompleteKeys = incompleteReconcileGroupKeys(groups, drafts);
    const decisions = buildReconcileDecisions(groups, drafts);

    const applyMutation = useMutation({
        mutationFn: (input: { decisions: ReconcileDecision[]; names: Map<string, string>; assets: Map<string, string> }) => runReconcileApplyBatches(projectId, input.decisions),
        onSuccess: (result, variables) => {
            setApplyError("");
            setReceipts(result.results);
            // 回执名字用提交那一刻的快照：重新 GET 后已归并组会移出台账。
            setReceiptSnapshot({ names: variables.names, assets: variables.assets });
            setDrafts({});
            // 决策会改变候选状态、资产列表和候选计数；处理后刷新对账台账。
            void queryClient.invalidateQueries({ queryKey: ["project", projectId, "asset-reconciliation"] });
            void queryClient.invalidateQueries({ queryKey: ["project", projectId, "assets"] });
            void queryClient.invalidateQueries({ queryKey: ["project", projectId, "asset-candidates"] });
            message.success(result.replayed ? "归并决策已确认（命中幂等回执）" : "归并决策已确认");
        },
        onError: (error, variables) => {
            if (error instanceof ReconcileBatchFailure && error.applied.length) {
                // 前面批次已落库：保留这些回执并刷新，失败批次的决策留在表单里可继续重试。
                setReceipts(error.applied);
                setReceiptSnapshot({ names: variables.names, assets: variables.assets });
                void queryClient.invalidateQueries({ queryKey: ["project", projectId, "asset-reconciliation"] });
                void queryClient.invalidateQueries({ queryKey: ["project", projectId, "assets"] });
                void queryClient.invalidateQueries({ queryKey: ["project", projectId, "asset-candidates"] });
            }
            setApplyError(error instanceof Error ? error.message : "归并确认失败");
        },
    });

    const setDraft = (group: AssetReconciliationGroup, draft: ReconcileDecisionDraft) => {
        setDrafts((current) => ({ ...current, [group.key]: draft }));
    };
    const draftFor = (group: AssetReconciliationGroup) => resolveReconcileDecision(group, drafts);
    const unitLabel = (unitId?: string) => (unitId && unitTitleById.get(unitId)) || "未分集";

    return (
        <section data-testid="project-asset-reconciliation" aria-label="跨集对账" className="flex flex-col gap-5">
            <header className="flex flex-col gap-1">
                <h2 className="text-[var(--fs-heading-lg)] font-semibold leading-6">跨集资产对账</h2>
                <p className="text-[var(--fs-label)] leading-5 text-foreground/48">
                    按名称与别名做确定性匹配；合并或新建后，同实体其他集由服务端自动归并。
                </p>
            </header>

            {reconciliationQuery.isLoading ? <WorkspaceState icon="assets" compact title="正在读取跨集对账台账" /> : null}
            {reconciliationQuery.isError ? (
                <Callout
                    data-testid="reconcile-load-error"
                    tone="error"
                    title="对账台账读取失败"
                    action={<Button size="small" autoInsertSpace={false} onClick={() => void reconciliationQuery.refetch()}>重试</Button>}
                >
                    {reconciliationQuery.error instanceof Error ? reconciliationQuery.error.message : "服务暂时不可用，当前决策不会被覆盖。"}
                </Callout>
            ) : null}

            {isEmpty ? (
                <Callout data-testid="reconcile-empty" tone="info" title="当前没有需要处理的跨集差异">
                    各集引用的资产版本一致，也没有待确认的候选实体。
                </Callout>
            ) : null}

            {reconciliationQuery.isSuccess && hasInventory ? (
                <section data-testid="reconcile-inventory" aria-label="逐集资产版本清单" className="flex flex-col gap-3">
                    <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground/55"><Layers3 className="size-3.5 text-foreground/45" />逐集资产版本清单</h3>
                    <div className="grid gap-2 lg:grid-cols-2">
                        {units.map((unit) => (
                            <article key={unit.unitId} className="rounded-lg bg-surface-active p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <h4 className="truncate text-xs font-semibold">{unit.unitTitle}</h4>
                                    <span className="text-[var(--fs-tiny)] tabular-nums text-foreground/42">{unit.entries.length} 项资产</span>
                                </div>
                                {unit.entries.length ? (
                                    <div className="mt-2 flex flex-col gap-2">
                                        {unit.entries.map((entry) => (
                                            <div key={entry.assetId} className="rounded-md bg-foreground/[.035] px-2.5 py-2">
                                                <div className="flex min-w-0 items-center gap-1.5">
                                                    <span className="truncate text-xs font-medium">{entry.title}</span>
                                                    <span className="shrink-0 text-[var(--fs-tiny)] text-foreground/42">{categoryLabel(entry.category)}</span>
                                                </div>
                                                <ul className="mt-1.5 flex flex-col gap-1">
                                                    {entry.versions.map((usage) => (
                                                        <li key={usage.versionId} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[var(--fs-tiny)] text-foreground/52">
                                                            <span className="tabular-nums text-foreground/62">v{usage.version}</span>
                                                            {usage.isPrimary ? <span className="text-foreground/48">主版本</span> : null}
                                                            <span className="tabular-nums text-foreground/42">{usage.shotIds.length} 镜头</span>
                                                            {usage.roles.length ? <span className="text-foreground/45">{usage.roles.join("、")}</span> : null}
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="mt-2 text-[var(--fs-tiny)] text-foreground/42">本集暂无镜头引用资产</p>
                                )}
                            </article>
                        ))}
                    </div>
                </section>
            ) : null}

            {reconciliationQuery.isSuccess && drifts.length ? (
                <section data-testid="reconcile-drifts" aria-label="漂移台账" className="flex flex-col gap-3">
                    <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground/55"><Split className="size-3.5 text-foreground/45" />漂移台账 · {drifts.length} 项</h3>
                    <div className="grid gap-2 lg:grid-cols-2">
                        {drifts.map((drift, index) => (
                            <article key={`${drift.kind}-${drift.shotId || drift.assetId || drift.artifactId || index}`} className="flex items-start gap-2.5 rounded-lg bg-surface-active p-3">
                                <span className="mt-0.5 rounded bg-foreground/[.06] px-1.5 py-0.5 text-[var(--fs-tiny)] font-medium text-foreground/62">{assetDriftKindLabel(drift.kind)}</span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs leading-5 text-foreground/62">{drift.reason}</p>
                                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[var(--fs-tiny)] text-foreground/42">
                                        {(() => {
                                            const href = drift.unitId ? chapterShotHref(projectId, drift.unitId, drift.shotId) : "";
                                            const label = `${drift.unitId ? unitLabel(drift.unitId) : ""}${drift.shotId ? ` · 分镜 ${drift.shotId}` : ""}`;
                                            return href
                                                ? <Link to={href} className="rounded text-[var(--workspace-accent)] underline-offset-2 hover:underline">{label}</Link>
                                                : <>
                                                    {drift.unitId ? <span>{unitLabel(drift.unitId)}</span> : null}
                                                    {drift.shotId ? <span className="tabular-nums">分镜 {drift.shotId}</span> : null}
                                                </>;
                                        })()}
                                        {drift.assetTitle ? <span>{drift.assetTitle}</span> : null}
                                        {drift.versionIds?.length ? <span className="tabular-nums">{drift.versionIds.join(" / ")}</span> : null}
                                        {drift.artifactType ? <span>产物 {drift.artifactType}</span> : null}
                                    </div>
                                </div>
                            </article>
                        ))}
                    </div>
                </section>
            ) : null}

            {reconciliationQuery.isSuccess && !isEmpty ? (
                <section aria-label="候选实体归并" className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground/55"><Sparkles className="size-3.5 text-foreground/45" />候选实体归并</h3>
                        <div className="flex flex-wrap items-center gap-2">
                            {decisions.length > RECONCILE_APPLY_MAX_DECISIONS ? (
                                <span data-testid="reconcile-batch-hint" className="text-[var(--fs-tiny)] text-foreground/42">
                                    本轮 {decisions.length} 条决策将分 {chunkReconcileDecisions(decisions).length} 批提交，单批上限 {RECONCILE_APPLY_MAX_DECISIONS} 条。
                                </span>
                            ) : null}
                            <Button
                                type="primary"
                                size="small"
                                disabled={!decisions.length || incompleteKeys.length > 0 || applyMutation.isPending}
                                loading={applyMutation.isPending}
                                onClick={() => applyMutation.mutate({ decisions, names: new Map(nameByCandidateId), assets: new Map(assetTitleById) })}
                            >
                                全部确认
                            </Button>
                        </div>
                    </div>
                    {incompleteKeys.length ? (
                        <Callout tone="warning" title="还有实体缺少合并目标">
                            选择「合并到已有资产」的实体需要指定目标资产，才能全部确认。
                        </Callout>
                    ) : null}
                    {groups.length ? (
                        <div className="grid gap-2 lg:grid-cols-2">
                            {groups.map((group) => {
                                const draft = draftFor(group);
                                const unitNames = group.appearances.map((appearance) => unitLabel(appearance.unitId));
                                return (
                                    <article
                                        key={group.key}
                                        data-testid={`reconcile-group-${group.key}`}
                                        className="flex flex-col gap-2.5 rounded-lg bg-surface-active p-3"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <h4 className="truncate text-xs font-semibold">{group.name}</h4>
                                                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--fs-tiny)] text-foreground/42">
                                                    <span>{categoryLabel(group.category)}</span>
                                                    <span className="tabular-nums">出现 {group.appearances.length} 次</span>
                                                    <span>{Array.from(new Set(unitNames)).join("、")}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-start gap-1.5 rounded-md bg-foreground/[.035] px-2.5 py-2">
                                            <Wand2 className="mt-px size-3.5 shrink-0 text-foreground/40" />
                                            <p className="min-w-0 text-[var(--fs-tiny)] leading-4 text-foreground/52">
                                                <span className="text-foreground/62">{suggestionMatchLabel(group.suggestion.match)}</span>
                                                <span className="text-foreground/42"> · {group.suggestion.reason}</span>
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <button
                                                type="button"
                                                aria-pressed={draft.action === "merge"}
                                                onClick={() => setDraft(group, { action: "merge", assetId: draft.assetId || (group.suggestion.action === "merge" ? group.suggestion.assetId : undefined) })}
                                                className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[var(--fs-tiny)] font-medium ${draft.action === "merge" ? "bg-foreground/[.1] text-foreground" : "text-foreground/52 hover:bg-surface-hover"}`}
                                            >
                                                <GitMerge className="size-3.5" />合并到已有资产
                                            </button>
                                            <button
                                                type="button"
                                                aria-pressed={draft.action === "create"}
                                                onClick={() => setDraft(group, { action: "create" })}
                                                className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[var(--fs-tiny)] font-medium ${draft.action === "create" ? "bg-foreground/[.1] text-foreground" : "text-foreground/52 hover:bg-surface-hover"}`}
                                            >
                                                <Plus className="size-3.5" />新建资产
                                            </button>
                                        </div>
                                        {draft.action === "merge" ? (
                                            <label className="flex flex-col gap-1">
                                                <span className="text-[var(--fs-tiny)] text-foreground/42">目标资产</span>
                                                <Select
                                                    aria-label="目标资产"
                                                    size="small"
                                                    placeholder="选择要并入的项目资产"
                                                    value={draft.assetId || undefined}
                                                    onChange={(assetId) => setDraft(group, { action: "merge", assetId })}
                                                    options={mergeTargetOptions(group, targetAssets)}
                                                    showSearch
                                                    optionFilterProp="label"
                                                />
                                            </label>
                                        ) : (
                                            <p className="text-[var(--fs-tiny)] text-foreground/42">将新建资产，并把同一实体的跨集出现归并到新资产。</p>
                                        )}
                                    </article>
                                );
                            })}
                        </div>
                    ) : (
                        <Callout data-testid="reconcile-groups-empty" tone="success" title="本轮候选已全部确认">
                            所有实体的跨集出现都已归并，新的候选出现会再出现在这里。
                        </Callout>
                    )}
                </section>
            ) : null}

            {applyError ? (
                <Callout data-testid="reconcile-apply-error" tone="error" title="归并确认失败">
                    {applyError}
                </Callout>
            ) : null}

            {receipts.length ? (
                <section data-testid="reconcile-receipts" aria-label="本轮回执" className="flex flex-col gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground/55"><GitMerge className="size-3.5 text-foreground/45" />本轮回执</h3>
                    <ul className="flex flex-col gap-1.5">
                        {receipts.map((item, index) => {
                            const assetTitle = item.assetId ? receiptSnapshot.assets.get(item.assetId) : "";
                            return (
                                <li key={`${item.candidateId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-foreground/[.035] px-2.5 py-1.5 text-[var(--fs-tiny)]">
                                    <span className="font-medium text-foreground/70">{receiptSnapshot.names.get(item.candidateId) || item.candidateId}</span>
                                    <span className="text-foreground/55">{reconcileOutcomeLabel(item.outcome)}</span>
                                    <span className="text-foreground/42">{item.action === "create" ? "新建资产" : "合并归并"}</span>
                                    {assetTitle ? <span className="text-foreground/45">{assetTitle}</span> : null}
                                    <span className="text-foreground/38">{reconcileCandidateStatusLabel(item.candidateStatus)}</span>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ) : null}
        </section>
    );
}
