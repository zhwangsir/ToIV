/**
 * C1c:创作六阶段轨道(script/assets/storyboard/generate/voice/timeline)。
 *
 * 真源纪律:只消费后端 stage_states / stage_revision;确认/跳过/重开走
 * POST /studio/projects/{pid}/stage-transition(带 expected_stage_revision 乐观并发,
 * stage_revision 缺失时明确提示不兼容,不发 undefined CAS);动作成功或 409 冲突后
 * 必须调用 onReload(parent 的 load())重新派生阶段,不在组件内伪造 confirmed;
 * onReload 返回 null 时诚实提示「刷新未确认」。旧服务端无 stage_states(六段不全)
 * 或无项目时,回退既有 CreationPhaseStrip 四阶段(老 API/视觉保留,不空白崩溃)。
 */
import { Check, CircleAlert, History, RotateCcw, SkipForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CreationPhaseStrip, type CreationPhaseId } from "@/components/toiv/creation-phase-strip";
import { StatusBadge } from "@/components/ui/base/badges";
import { ToolButton } from "@/components/ui/base/buttons";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { AppModal } from "@/components/ui/product/app-modal";
import {
    STAGE_STATE_META,
    STUDIO_STAGES,
    firstBlockingStage,
    hasStageStates,
    stageActionsFor,
    stageNavSection,
    stageStateOf,
    stageTransitionConflictMessage,
    type StudioNavSection,
} from "@/lib/studio-stage-progress";
import {
    fetchStageHistory,
    transitionProjectStage,
    type ToivDramaDetail,
    type ToivStageHistoryEntry,
    type ToivStageId,
} from "@/services/toiv/client";

const BADGE_TONE: Record<string, "neutral" | "success" | "warning" | "error" | "loading"> = {
    muted: "neutral",
    info: "loading",
    success: "success",
    warning: "warning",
    danger: "error",
    accent: "loading",
};

const HISTORY_SOURCE_LABELS: Record<string, string> = {
    confirm: "确认",
    skip: "跳过",
    reopen: "重开",
    agent: "智能体",
    manual: "人工",
    system: "系统",
};

function historySourceLabel(source: string): string {
    return HISTORY_SOURCE_LABELS[source] ?? source;
}

function formatHistoryTime(createdAt: string): string {
    const t = new Date(createdAt);
    return Number.isNaN(t.getTime()) ? createdAt : t.toLocaleString("zh-CN", { hour12: false });
}

function legacyPhaseFromSection(section: string | null): CreationPhaseId {
    if (section === "script") return "script";
    if (section === "assets") return "asset";
    if (section === "storyboard") return "keyframe";
    return "generate";
}

const LEGACY_PHASE_NAV: Record<CreationPhaseId, StudioNavSection> = {
    script: "script",
    asset: "assets",
    keyframe: "storyboard",
    generate: "shots",
};

export type CreationStageTrackProps = {
    /** 项目详情真源(slots 注册的 drama-workspace detail);null = 无项目 */
    detail: ToivDramaDetail | null;
    /** 当前 section,用于激活高亮与四阶段回退 */
    section?: string | null;
    /** 阶段导航(保持 /create?project=...&section=... 由 parent 组装) */
    onNavigate?: (nav: StudioNavSection) => void;
    /** 动作成功 / 409 冲突后必须调用的项目 load():重新从服务端派生阶段;返回 null = 刷新未确认 */
    onReload?: () => Promise<ToivDramaDetail | null> | ToivDramaDetail | null;
    /** C1c 阻断定位:变化时选中对应阶段(由 parent 经 slots.requestStageFocus 驱动) */
    focusStage?: ToivStageId;
};

export function CreationStageTrack({ detail, section = null, onNavigate, onReload, focusStage }: CreationStageTrackProps) {
    // ---- 旧服务端 / 无项目:保留原四阶段(老 API/视觉,onSelect 映射到区段导航) ----
    if (!detail || !hasStageStates(detail)) {
        return (
            <div data-testid="creation-stage-track" data-variant="legacy">
                <CreationPhaseStrip
                    active={legacyPhaseFromSection(section)}
                    onSelect={(phase) => onNavigate?.(LEGACY_PHASE_NAV[phase])}
                />
            </div>
        );
    }
    return <StageTrackInner detail={detail} section={section} onNavigate={onNavigate} onReload={onReload} focusStage={focusStage} />;
}

function StageTrackInner({ detail, section, onNavigate, onReload, focusStage }: CreationStageTrackProps & { detail: ToivDramaDetail }) {
    const pid = detail.id;
    const blocking = useMemo(() => firstBlockingStage(detail), [detail]);
    const [selectedStage, setSelectedStage] = useState<ToivStageId>(blocking ?? "script");
    const [busy, setBusy] = useState<ToivStageId | null>(null);
    const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
    const [skipOpen, setSkipOpen] = useState(false);
    const [skipNote, setSkipNote] = useState("");
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyStage, setHistoryStage] = useState<ToivStageId | "all">("all");
    const [history, setHistory] = useState<ToivStageHistoryEntry[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    /** pid 切换重置:selectedStage/message/弹窗/历史全部复位,旧投影不串号;
     *  在途历史请求一并失效(序号+1),historyLoading 复位,旧 pid 慢响应不得写入 */
    const prevPidRef = useRef(pid);
    /** 历史请求序号闸:旧筛选/旧 pid 的慢响应不得覆盖新请求;pid 切换/卸载时 +1 使在途请求失效 */
    const historySeqRef = useRef(0);
    useEffect(() => {
        if (prevPidRef.current === pid) return;
        prevPidRef.current = pid;
        historySeqRef.current += 1;
        setHistoryLoading(false);
        setSelectedStage(firstBlockingStage(detail) ?? "script");
        setMessage(null);
        setSkipOpen(false);
        setSkipNote("");
        setHistoryOpen(false);
        setHistoryStage("all");
        setHistory([]);
        setHistoryError(null);
    }, [pid, detail]);
    /** 卸载时在途历史请求失效(组件重挂后序号不衔接旧请求) */
    useEffect(() => () => { historySeqRef.current += 1; }, []);
    /** 阻断定位:focusStage 变化时选中对应阶段 */
    useEffect(() => {
        if (focusStage) setSelectedStage(focusStage);
    }, [focusStage]);

    /** CAS 基线:stage_revision 缺失 → 明确不兼容,不发 undefined CAS 冒充旧服务兼容 */
    const casReady = typeof detail.stage_revision === "number";

    const runTransition = useCallback(async (stage: ToivStageId, action: "confirm" | "skip" | "reopen", note?: string) => {
        if (!casReady || busy !== null) return;
        setBusy(stage);
        setMessage(null);
        try {
            await transitionProjectStage(pid, {
                stage,
                action,
                ...(note?.trim() ? { note: note.trim() } : {}),
                expected_stage_revision: detail.stage_revision as number,
            });
            // 成功不本地伪造:真源由 parent load() 重新派生;load() 返回 null 时诚实提示
            const fresh = await onReload?.();
            const refreshed = fresh !== null && fresh !== undefined;
            setMessage({
                tone: refreshed ? "success" : "error",
                text: !refreshed
                    ? "已提交,但项目刷新未确认(可能已切换项目或加载失败),请手动刷新后核对"
                    : action === "confirm" ? "已确认,阶段状态已从服务端刷新" : action === "skip" ? "已跳过该阶段" : "已重开,请检查后重新确认",
            });
        } catch (e) {
            const conflict = stageTransitionConflictMessage(e);
            if (conflict) {
                // 409:保留后端冲突说明,并刷新到服务端真值(最新 stage_revision/状态)
                setMessage({ tone: "error", text: `${conflict}(已尝试刷新到最新状态,请核对后再操作)` });
                await onReload?.();
            } else {
                setMessage({ tone: "error", text: e instanceof Error ? e.message : "阶段操作失败" });
            }
        } finally {
            setBusy(null);
            setSkipOpen(false);
            setSkipNote("");
        }
    }, [pid, detail.stage_revision, casReady, busy, onReload]);

    const openHistory = useCallback(async (stage: ToivStageId | "all") => {
        const seq = ++historySeqRef.current;
        setHistoryStage(stage);
        setHistoryError(null);
        setHistoryLoading(true);
        try {
            const list = await fetchStageHistory(pid, stage === "all" ? undefined : stage);
            // 序号闸:期间 pid 切换或又发了新筛选 → 丢弃本次结果
            if (seq !== historySeqRef.current) return;
            setHistory(list.history);
        } catch (e) {
            if (seq !== historySeqRef.current) return;
            setHistoryError(e instanceof Error ? e.message : "阶段历史加载失败");
        } finally {
            if (seq === historySeqRef.current) setHistoryLoading(false);
        }
    }, [pid]);

    const selectedDef = STUDIO_STAGES.find((s) => s.id === selectedStage) ?? STUDIO_STAGES[0];
    const selectedState = stageStateOf(detail, selectedStage);
    const actions = stageActionsFor(selectedState?.state);
    const reopenLabel = selectedState?.state === "needs_review" ? "重开再确认" : "重开";

    return (
        <div data-testid="creation-stage-track" data-variant="six" className="toiv-stage-track">
            <ol className="toiv-stage-track-list" aria-label="创作阶段轨道">
                {STUDIO_STAGES.map((stage) => {
                    const state = stageStateOf(detail, stage.id);
                    const meta = STAGE_STATE_META[state?.state ?? "draft"];
                    const pressed = stage.id === selectedStage;
                    const onSection = stage.navSection === section;
                    return (
                        <li key={stage.id} className="toiv-stage-track-item">
                            <button
                                type="button"
                                className={`toiv-stage-track-chip${pressed ? " is-active" : ""}`}
                                aria-pressed={pressed}
                                aria-current={onSection ? "step" : undefined}
                                title={stage.hint}
                                onClick={() => setSelectedStage(stage.id)}
                            >
                                <span className="toiv-stage-track-index">{stage.index}</span>
                                <span className="toiv-stage-track-label">{stage.label}</span>
                                <StatusBadge variant="filled" tone={BADGE_TONE[meta.tone]} label={meta.label} size="sm" />
                            </button>
                        </li>
                    );
                })}
            </ol>

            <div className="toiv-stage-track-actions">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                        {selectedDef.index} {selectedDef.label}
                    </span>
                    {selectedState?.blockers?.map((b) => (
                        <span key={b} className="inline-flex items-center gap-1 text-tiny text-status-warning">
                            <CircleAlert className="size-3" aria-hidden />
                            {b}
                        </span>
                    ))}
                    <span className="flex-1" />
                    <ToolButton size="xs" variant="ghost" icon={<History />} label="阶段历史" onClick={() => { setHistoryOpen(true); void openHistory("all"); }} />
                    <ToolButton size="xs" variant="ghost" icon={<RotateCcw />} label="前往" onClick={() => onNavigate?.(stageNavSection(selectedStage))} />
                </div>
                {!casReady && (
                    <p data-testid="stage-track-cas-missing" className="rounded border border-[var(--border)] p-2 text-xs text-status-warning">
                        服务端未提供 stage_revision,阶段确认/跳过/重开不可用(后端版本不兼容,请升级后再试)
                    </p>
                )}
                {casReady && (actions.canConfirm || actions.canSkip || actions.canReopen) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                        {actions.canConfirm && (
                            <ToolButton
                                size="xs"
                                variant="default"
                                icon={<Check />}
                                label={busy === selectedStage ? "提交中…" : "确认"}
                                loading={busy === selectedStage}
                                disabled={busy !== null}
                                onClick={() => void runTransition(selectedStage, "confirm")}
                            />
                        )}
                        {actions.canReopen && (
                            <ToolButton
                                size="xs"
                                variant="ghost"
                                icon={<RotateCcw />}
                                label={reopenLabel}
                                loading={busy === selectedStage}
                                disabled={busy !== null}
                                onClick={() => void runTransition(selectedStage, "reopen")}
                            />
                        )}
                        {actions.canSkip && (
                            <ToolButton
                                size="xs"
                                variant="ghost"
                                icon={<SkipForward />}
                                label="跳过"
                                disabled={busy !== null}
                                onClick={() => { setSkipNote(""); setSkipOpen(true); }}
                            />
                        )}
                    </div>
                )}
                {message && (
                    <p
                        data-testid="stage-track-message"
                        className={`rounded border border-[var(--border)] p-2 text-xs ${message.tone === "error" ? "text-[var(--danger)]" : "text-foreground"}`}
                    >
                        {message.text}
                    </p>
                )}
            </div>

            <AppModal
                open={skipOpen}
                title={`跳过「${selectedDef.label}」`}
                onCancel={() => { setSkipOpen(false); setSkipNote(""); }}
                footer={null}
                destroyOnHidden
            >
                <div className="flex flex-col gap-2 p-4 text-xs">
                    <label className="font-medium text-foreground" htmlFor="stage-skip-note">
                        跳过说明(必填)
                    </label>
                    <textarea
                        id="stage-skip-note"
                        data-testid="stage-skip-note"
                        value={skipNote}
                        onChange={(e) => setSkipNote(e.target.value)}
                        rows={3}
                        placeholder="例如:复用旧项目资产 / 本剧无台词跳过配音"
                        className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-foreground"
                    />
                    <div className="flex justify-end gap-1.5">
                        <ToolButton size="xs" variant="ghost" label="取消" onClick={() => { setSkipOpen(false); setSkipNote(""); }} />
                        <ToolButton
                            size="xs"
                            variant="default"
                            icon={<SkipForward />}
                            label="确认跳过"
                            disabled={!skipNote.trim() || busy !== null}
                            loading={busy === selectedStage}
                            onClick={() => void runTransition(selectedStage, "skip", skipNote)}
                        />
                    </div>
                </div>
            </AppModal>

            <AppDrawer
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                width={480}
                title="阶段历史"
            >
                <div data-testid="stage-history-drawer" className="flex flex-col gap-3 p-4 text-xs">
                    <div role="radiogroup" aria-label="按阶段筛选" className="flex flex-wrap gap-1.5">
                        {[{ id: "all" as const, label: "全部" }, ...STUDIO_STAGES].map((s) => (
                            <label key={s.id} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-tiny text-foreground">
                                <input
                                    type="radio"
                                    name="stage-history-filter"
                                    checked={historyStage === s.id}
                                    onChange={() => void openHistory(s.id as ToivStageId | "all")}
                                />
                                {s.label}
                            </label>
                        ))}
                    </div>
                    {historyLoading && <p className="text-[var(--muted-foreground)]">加载阶段历史…</p>}
                    {historyError && <p className="rounded border border-[var(--border)] p-2 text-[var(--danger)]">{historyError}</p>}
                    {!historyLoading && history.length === 0 && !historyError && (
                        <p className="text-[var(--muted-foreground)]">暂无阶段流转记录</p>
                    )}
                    <ol className="flex flex-col gap-1.5">
                        {history.map((h) => {
                            const stageLabel = STUDIO_STAGES.find((s) => s.id === h.stage)?.label ?? h.stage;
                            const fromLabel = STAGE_STATE_META[h.from_state as keyof typeof STAGE_STATE_META]?.label ?? h.from_state;
                            const toLabel = STAGE_STATE_META[h.to_state as keyof typeof STAGE_STATE_META]?.label ?? h.to_state;
                            return (
                                <li key={h.id} className="rounded-lg border border-[var(--border)] px-3 py-2">
                                    <p className="text-foreground">
                                        {stageLabel} · {fromLabel} → {toLabel} · {historySourceLabel(h.source)}
                                        <span className="ml-2 text-[var(--muted-foreground)]">{formatHistoryTime(h.created_at)}</span>
                                    </p>
                                    {h.note ? <p className="break-words text-[var(--muted-foreground)]">{h.note}</p> : null}
                                </li>
                            );
                        })}
                    </ol>
                </div>
            </AppDrawer>
        </div>
    );
}

/** 批量 render / assemble 被阶段闸 409 拦截时的阻断引导:显示后端原因 + 打开对应阶段的入口。
 *  onOpenStage 把「如何让用户直达该阶段」交还给调用方(如 slots.requestStageFocus 打开右栏 Inspector),
 *  本组件不内置导航,不另造项目真源。 */
export function StageBlockNotice({
    message,
    stageId,
    onOpenStage,
}: {
    message: string;
    stageId: ToivStageId | null;
    onOpenStage?: (stage: ToivStageId) => void;
}) {
    const stageLabel = stageId ? (STUDIO_STAGES.find((s) => s.id === stageId)?.label ?? stageId) : null;
    return (
        <div data-testid="stage-block-notice" className="toiv-stage-block-notice" role="alert">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 break-words">{message}</span>
            {stageId && stageLabel && (
                <ToolButton
                    size="xs"
                    variant="default"
                    label={`前往「${stageLabel}」阶段`}
                    onClick={() => onOpenStage?.(stageId)}
                />
            )}
        </div>
    );
}
