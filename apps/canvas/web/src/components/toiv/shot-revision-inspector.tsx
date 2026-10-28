/**
 * C1a:分镜 Inspector 修订编辑 + stale 投影 + 修订历史(diff/回滚)。
 *
 * 只消费后端真值:expected_revision 乐观并发、指纹派生的 media status、
 * 真实 GET revisions/diff 与 POST rollback。前端不自造 hash/版本。
 * 保存走全量 PUT(全镜 payload + 每镜 expected_revision),绝不改成单镜。
 */
import { Check, CircleDollarSign, Columns2, FlaskConical, History, Mic, Pencil, PlayCircle, Save, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { RenderCostEstimate } from "@/components/toiv/render-cost-estimate";
import { ShotRecipePanel } from "@/components/toiv/shot-recipe-panel";
import { TakeComparePanel } from "@/components/toiv/take-compare-panel";
import { StatusBadge } from "@/components/ui/base/badges";
import { ToolButton } from "@/components/ui/base/buttons";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { hasUnsavedShotChanges } from "@/lib/render-estimate";
import {
    fetchShotRevisionDiff,
    fetchShotRevisions,
    rollbackShotRevision,
    saveStudioShots,
    type ToivDramaShot,
    type ToivParsedShot,
    type ToivShotRevision,
    type ToivShotRevisionDiff,
    type ToivRecipeRenderParams,
    type RenderShotAsyncOpts,
} from "@/services/toiv/client";

// ---- 纯函数(可单测) ----

/** Inspector 单镜内容补丁(全量 PUT 中的一镜覆盖) */
export type ShotInspectorPatch = {
    id: string;
    fields: Partial<Pick<ToivDramaShot, "prompt" | "dialogue" | "scene" | "speaker" | "camera">>;
};

/**
 * 全量 PUT payload 构造(与 ShotInput 契约对齐):
 * 传入的全部镜都进 payload,每镜 expected_revision = current_revision_id(旧行空串)。
 * patch 只覆盖目标镜的指定内容字段;时间线时长/衔接覆盖可一并带上(不丢未保存的排序编辑)。
 */
export function buildShotsSavePayload(
    shots: ToivDramaShot[],
    opts?: {
        durationSec?: Record<string, number>;
        seamToNext?: Record<string, string>;
        patch?: ShotInspectorPatch;
    },
): ToivParsedShot[] {
    return shots.map((x) => {
        const patched = opts?.patch && x.id === opts.patch.id ? opts.patch.fields : null;
        return {
            id: x.id,
            scene: (patched?.scene ?? x.scene) ?? "",
            prompt: (patched?.prompt ?? x.prompt) ?? "",
            negative: x.negative ?? "",
            camera: (patched?.camera ?? x.camera) ?? "",
            dialogue: (patched?.dialogue ?? x.dialogue) ?? "",
            speaker: (patched?.speaker ?? x.speaker) ?? "",
            duration_sec: opts?.durationSec?.[x.id] ?? x.duration_sec ?? 6,
            characters: (x.characters ?? []) as string[],
            render_mode: x.render_mode ?? "video",
            seam_to_next: opts?.seamToNext?.[x.id] ?? x.seam_to_next ?? "hardcut",
            beats: x.beats ?? [],
            ref_epoch: x.ref_epoch ?? null,
            ref_epoch_note: x.ref_epoch_note ?? null,
            expected_revision: x.current_revision_id ?? "",
        };
    });
}

/** 409 乐观并发冲突 → 后端 detail;非 409 → null(交由常规错误处理) */
export function shotSaveConflictMessage(e: unknown): string | null {
    const resp = (e as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
    if (resp?.status !== 409) return null;
    const detail = resp.data?.detail;
    return typeof detail === "string" && detail.trim() ? detail : "分镜已被其他修改更新,请刷新后重试";
}

export type ShotMediaBadge = { key: "visual" | "audio" | "final"; tone: "warning" | "neutral"; label: string };

/** stale/unknown 徽章;none/current(或字段缺失)不显示——没有产物不冒充已同步 */
export function shotMediaBadges(shot: Pick<ToivDramaShot, "visual_media_status" | "audio_media_status" | "final_media_status">): ShotMediaBadge[] {
    const badges: ShotMediaBadge[] = [];
    if (shot.visual_media_status === "stale") badges.push({ key: "visual", tone: "warning", label: "视觉待重渲" });
    else if (shot.visual_media_status === "unknown") badges.push({ key: "visual", tone: "neutral", label: "视觉状态未知" });
    if (shot.audio_media_status === "stale") badges.push({ key: "audio", tone: "warning", label: "配音待重录" });
    else if (shot.audio_media_status === "unknown") badges.push({ key: "audio", tone: "neutral", label: "配音状态未知" });
    if (shot.final_media_status === "stale") badges.push({ key: "final", tone: "warning", label: "成片待重合成" });
    else if (shot.final_media_status === "unknown") badges.push({ key: "final", tone: "neutral", label: "成片状态未知" });
    return badges;
}

/** final_clip 的 success「成片段」徽标准入:stale/unknown 时不得伪装最新;current/旧数据(字段缺失)维持原样 */
export function showFinalClipFreshBadge(shot: Pick<ToivDramaShot, "final_clip_url" | "final_media_status">): boolean {
    if (!shot.final_clip_url) return false;
    return !shot.final_media_status || shot.final_media_status === "current";
}

const RENDERED_STATES = new Set(["rendering", "rendered", "voiced", "lipsynced", "done"]);

/** legacy「跳过口型」可见条件(与 drama-workspace 原 parent 实现一致) */
export function showSkipLipsyncButton(shot: Pick<ToivDramaShot, "voice_url" | "status">): boolean {
    return Boolean(shot.voice_url) && !["lipsyncing", "lipsynced"].includes(shot.status);
}

/** 渲染/配音/口型按钮闸:有 stale 时即使 status=rendered/voiced 也可重渲/重配音(不强制删旧媒体);
 *  口型主操作同屏只有一个:final stale →「重对口型」(需 voice+video 可用),否则 legacy「对口型」 */
export function shotInspectorActions(
    shot: ToivDramaShot,
    opts: { busy: boolean; makeupReady: boolean },
): { canRender: boolean; canVoice: boolean; renderLabel: string; voiceLabel: string; canLipsync: boolean; lipsyncLabel: string } {
    const visualStale = shot.visual_media_status === "stale";
    const audioStale = shot.audio_media_status === "stale";
    const finalStale = shot.final_media_status === "stale";
    const hasDlg = Boolean((shot.dialogue ?? "").trim());
    const canRender = (!RENDERED_STATES.has(shot.status) || visualStale) && !opts.busy && opts.makeupReady;
    const canVoice = hasDlg && !opts.busy && ((shot.status === "rendered" && !shot.voice_url) || audioStale);
    const canLipsync = !opts.busy && (finalStale
        ? Boolean(shot.voice_url) && Boolean(shot.video_url) && shot.status !== "lipsyncing"
        : showSkipLipsyncButton(shot));
    return {
        canRender,
        canVoice,
        renderLabel: visualStale ? "重渲染" : "渲染",
        voiceLabel: audioStale ? "重配音" : "配音",
        canLipsync,
        lipsyncLabel: finalStale ? "重对口型" : "对口型",
    };
}

export const REVISION_SOURCE_LABELS: Record<string, string> = {
    "manual-edit": "手工编辑",
    rollback: "回滚",
    imported: "导入",
    render: "生成",
};

export function revisionSourceLabel(source: string): string {
    return REVISION_SOURCE_LABELS[source] ?? source;
}

export const REVISION_FIELD_LABELS: Record<string, string> = {
    idx: "序号",
    scene: "场景",
    prompt: "提示语",
    negative: "负向词",
    camera: "运镜",
    dialogue: "台词",
    speaker: "说话人",
    duration_sec: "时长",
    characters: "角色",
    render_mode: "生成方式",
    seam_to_next: "衔接",
    seam_anchor: "衔接锚点",
    ref_epoch: "参考纪元",
    ref_epoch_note: "纪元备注",
};

function revisionFieldLabel(field: string): string {
    return REVISION_FIELD_LABELS[field] ?? field;
}

function formatRevisionTime(createdAt: string): string {
    const t = new Date(createdAt);
    return Number.isNaN(t.getTime()) ? createdAt : t.toLocaleString("zh-CN", { hour12: false });
}

// ---- 组件 ----

type EditableField = "prompt" | "dialogue";

export type ShotInspectorPanel = "compare" | "recipes" | "history" | "estimate";

export function shotInspectorPanelFromQuery(value: string | null): ShotInspectorPanel | null {
    return value === "compare" || value === "recipes" || value === "history" || value === "estimate" ? value : null;
}

export type ShotRevisionInspectorProps = {
    projectId: string;
    shot: ToivDramaShot;
    /** 全量镜集合(页面传 tlShots 顺序集,保证 PUT 不丢镜/不丢未保存排序) */
    shots: ToivDramaShot[];
    initialPanel?: ShotInspectorPanel;
    durationSec?: Record<string, number>;
    seamToNext?: Record<string, string>;
    busy?: boolean;
    makeupReady?: boolean;
    onSaved: () => Promise<void> | void;
    onError?: (message: string) => void;
    renderOptions?: RenderShotAsyncOpts;
    onRender?: (shotId: string, options?: RenderShotAsyncOpts) => void;
    onKeyframeFocus?: () => void;
    onVoice?: (shotId: string) => void;
    /** final stale 的真实重对口型入口(parent 的 runLipsync;成功后由响应投影刷新,不本地伪造) */
    onLipsync?: (shotId: string) => void;
    /** legacy 跳过口型(parent 的 runSkipLipsync);loading/disabled/title 语义与 parent 原实现一致 */
    onSkipLipsync?: (shotId: string) => void;
    /** C1b:配方应用成功后用返回 render_params 调 parent 真实渲染(parent 补 wait=false/force_direct 与 keyframe 闸) */
    onApplyRender?: (shotId: string, params: ToivRecipeRenderParams) => void;
    lipsyncBusy?: boolean;
    voiceBlocked?: { blocked: boolean; hint: string };
};

export function ShotRevisionInspector({
    projectId,
    shot,
    shots,
    initialPanel,
    durationSec,
    seamToNext,
    busy = false,
    makeupReady = true,
    onSaved,
    onError,
    renderOptions = {},
    onRender,
    onKeyframeFocus,
    onVoice,
    onLipsync,
    onSkipLipsync,
    onApplyRender,
    lipsyncBusy = false,
    voiceBlocked,
}: ShotRevisionInspectorProps) {
    const [editing, setEditing] = useState<EditableField | null>(null);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

    // 历史、配方与候选对比抽屉互斥(activePanel 单选,避免重复入口同屏叠加)
    const [activePanel, setActivePanel] = useState<"history" | "recipes" | "compare" | null>(null);
    const [revisions, setRevisions] = useState<ToivShotRevision[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
    const [diff, setDiff] = useState<ToivShotRevisionDiff | null>(null);
    const [diffLoading, setDiffLoading] = useState(false);
    const [rollingBack, setRollingBack] = useState(false);
    const [estimateOpen, setEstimateOpen] = useState(false);
    const [estimateRevision, setEstimateRevision] = useState(0);
    const renderRequested = useRef(false);
    const shotInputKey = JSON.stringify({
        renderOptions,
        currentRevision: shot.current_revision_id,
        imageUrl: shot.image_url,
        status: shot.status,
    });
    const unsavedChanges = hasUnsavedShotChanges(
        shot,
        editing ? { field: editing, draft } : null,
        durationSec,
        seamToNext,
    );

    useEffect(() => {
        renderRequested.current = false;
        setEstimateOpen(false);
        setActivePanel(null);
    }, [shot.id]);

    useEffect(() => {
        renderRequested.current = false;
    }, [shotInputKey]);

    const openEstimate = (forRender: boolean) => {
        if (unsavedChanges) {
            renderRequested.current = false;
            setMessage({ tone: "error", text: "有未保存修改，请先保存再预估" });
            return;
        }
        if (forRender && renderRequested.current) return;
        renderRequested.current = forRender;
        setMessage(null);
        setEstimateOpen(true);
        setEstimateRevision((value) => value + 1);
    };

    const resolveEstimate = (allowed: boolean) => {
        if (!renderRequested.current) return;
        renderRequested.current = false;
        if (unsavedChanges) {
            setMessage({ tone: "error", text: "有未保存修改，请先保存再预估" });
            return;
        }
        if (allowed) onRender?.(shot.id, renderOptions);
    };

    const startEdit = (field: EditableField) => {
        renderRequested.current = false;
        setMessage(null);
        setDraft(String(shot[field] ?? ""));
        setEditing(field);
    };

    const cancelEdit = () => {
        setEditing(null);
        setDraft("");
    };

    const saveEdit = useCallback(async () => {
        if (!editing) return;
        setSaving(true);
        setMessage(null);
        try {
            const payload = buildShotsSavePayload(shots, {
                durationSec,
                seamToNext,
                patch: { id: shot.id, fields: { [editing]: draft } },
            });
            await saveStudioShots(projectId, payload);
            setEditing(null);
            setDraft("");
            setMessage({ tone: "success", text: "已保存并建立新修订" });
            await onSaved();
        } catch (e) {
            const conflict = shotSaveConflictMessage(e);
            if (conflict) {
                // 冲突:丢弃本地草稿(不覆盖),透出后端说明,并刷新到服务端真值
                setEditing(null);
                setDraft("");
                setMessage({ tone: "error", text: conflict });
                void onSaved();
            } else {
                const text = e instanceof Error ? e.message : "保存失败";
                setMessage({ tone: "error", text });
                onError?.(text);
            }
        } finally {
            setSaving(false);
        }
    }, [editing, draft, shots, durationSec, seamToNext, shot.id, projectId, onSaved, onError]);

    const openHistory = useCallback(async () => {
        setActivePanel("history");
        setHistoryError(null);
        setSelectedRevisionId(null);
        setDiff(null);
        setHistoryLoading(true);
        try {
            const list = await fetchShotRevisions(shot.id);
            setRevisions(list.revisions);
        } catch (e) {
            setHistoryError(e instanceof Error ? e.message : "修订历史加载失败");
        } finally {
            setHistoryLoading(false);
        }
    }, [shot.id]);

    useEffect(() => {
        renderRequested.current = false;
        setEstimateOpen(initialPanel === "estimate");
        if (initialPanel === "estimate") setEstimateRevision((value) => value + 1);
        if (initialPanel === "history") void openHistory();
        else setActivePanel(initialPanel === "compare" || initialPanel === "recipes" ? initialPanel : null);
    }, [shot.id, initialPanel, openHistory]);

    const selectRevision = useCallback(async (revisionId: string) => {
        setSelectedRevisionId(revisionId);
        setDiff(null);
        setDiffLoading(true);
        try {
            setDiff(await fetchShotRevisionDiff(shot.id, revisionId));
        } catch (e) {
            setHistoryError(e instanceof Error ? e.message : "修订对比加载失败");
        } finally {
            setDiffLoading(false);
        }
    }, [shot.id]);

    const rollback = useCallback(async (revisionId: string) => {
        setRollingBack(true);
        setHistoryError(null);
        try {
            // 乐观并发:带当前基线(旧行空串);后端不符 → 409,不落任何变更
            await rollbackShotRevision(shot.id, revisionId, shot.current_revision_id ?? "");
            setActivePanel(null);
            setMessage({ tone: "success", text: "已回滚到所选修订" });
            await onSaved();
        } catch (e) {
            const conflict = shotSaveConflictMessage(e);
            if (conflict) {
                setHistoryError(conflict);
                void onSaved();
            } else {
                setHistoryError(e instanceof Error ? e.message : "回滚失败");
            }
        } finally {
            setRollingBack(false);
        }
    }, [shot.id, shot.current_revision_id, onSaved]);

    const badges = shotMediaBadges(shot);
    const actions = shotInspectorActions(shot, { busy, makeupReady });
    const editable = !busy && !saving;

    const renderField = (field: EditableField, label: string, value: string) => (
        <div>
            <div className="flex items-center justify-between gap-2">
                <p className="mb-0.5 font-medium text-foreground">{label}</p>
                {editing !== field && (
                    <ToolButton size="xs" variant="ghost" icon={<Pencil />} label={`编辑${label}`} disabled={!editable} onClick={() => startEdit(field)} />
                )}
            </div>
            {editing === field ? (
                <div className="flex flex-col gap-1.5">
                    <textarea
                        data-testid="shot-revision-edit-textarea"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={field === "prompt" ? 4 : 2}
                        className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-foreground"
                        aria-label={`${label}编辑框`}
                    />
                    <div className="flex gap-1.5">
                        <ToolButton size="xs" variant="default" icon={<Save />} label={saving ? "保存中…" : "保存"} loading={saving} onClick={() => void saveEdit()} />
                        <ToolButton size="xs" variant="ghost" icon={<X />} label="取消" disabled={saving} onClick={cancelEdit} />
                    </div>
                </div>
            ) : (
                <p className="whitespace-pre-wrap break-words text-[var(--muted-foreground)]">{value.trim() || (field === "dialogue" ? "（无对白）" : "—")}</p>
            )}
        </div>
    );

    return (
        <>
            {renderField("prompt", "提示语", String(shot.prompt ?? shot.scene ?? ""))}
            {renderField("dialogue", "台词", String(shot.dialogue ?? ""))}
            {message && (
                <p
                    data-testid="shot-revision-message"
                    className={`rounded border border-[var(--border)] p-2 ${message.tone === "error" ? "text-[var(--danger)]" : "text-foreground"}`}
                >
                    {message.text}
                </p>
            )}
            {badges.length > 0 && (
                <div data-testid="shot-media-badges" className="flex flex-wrap gap-1">
                    {badges.map((b) => (
                        <StatusBadge key={b.key} variant="filled" tone={b.tone} label={b.label} size="sm" />
                    ))}
                </div>
            )}
            {showFinalClipFreshBadge(shot) && (
                <StatusBadge variant="filled" tone="success" label="成片段" size="sm" />
            )}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <ToolButton size="xs" variant="ghost" icon={<History />} label="修订历史" onClick={() => void openHistory()} />
                <ToolButton
                    size="xs"
                    variant="ghost"
                    icon={<FlaskConical />}
                    label="配方"
                    expands
                    active={activePanel === "recipes"}
                    onClick={() => setActivePanel((v) => (v === "recipes" ? null : "recipes"))}
                />
                <ToolButton
                    size="xs"
                    variant="ghost"
                    icon={<Columns2 />}
                    label="候选对比"
                    expands
                    active={activePanel === "compare"}
                    onClick={() => setActivePanel((v) => (v === "compare" ? null : "compare"))}
                />
                <ToolButton
                    size="xs"
                    variant="ghost"
                    icon={<CircleDollarSign />}
                    label="成本预估"
                    active={estimateOpen}
                    onClick={() => openEstimate(false)}
                />
                {actions.canRender && (
                    <ToolButton size="xs" variant="default" icon={<PlayCircle />} label={busy ? "渲染中…" : actions.renderLabel} onClick={() => openEstimate(true)} />
                )}
                {actions.canVoice && (
                    <ToolButton size="xs" variant="ghost" icon={<Volume2 />} label={actions.voiceLabel} onClick={() => onVoice?.(shot.id)} />
                )}
            </div>
            {estimateOpen && !unsavedChanges && (
                <RenderCostEstimate
                    scope="shot"
                    projectId={projectId}
                    shotId={shot.id}
                    open={estimateOpen}
                    accel={renderOptions.accel ?? "off"}
                    pipeline={renderOptions.pipeline ?? "ref2va"}
                    detail={`${estimateRevision}:${shotInputKey}`}
                    renderOptions={renderOptions}
                    onResolved={resolveEstimate}
                    onKeyframeFocus={onKeyframeFocus}
                />
            )}
            {(actions.canLipsync || showSkipLipsyncButton(shot)) && (
                <div data-testid="shot-lipsync-actions" className="flex flex-wrap items-center gap-1.5 pt-1">
                    {/* 口型主操作同屏只有一个:final stale → 重对口型,否则 legacy 对口型;
                        disabled/title 沿用 parent 的 voiceBlocked 语义 */}
                    {actions.canLipsync && (
                        <ToolButton
                            size="xs"
                            variant="ghost"
                            icon={<Mic />}
                            label={actions.lipsyncLabel}
                            loading={lipsyncBusy}
                            disabled={voiceBlocked?.blocked}
                            title={voiceBlocked?.blocked ? voiceBlocked.hint : undefined}
                            onClick={() => onLipsync?.(shot.id)}
                        />
                    )}
                    {showSkipLipsyncButton(shot) && (
                        <ToolButton size="xs" variant="ghost" icon={<Check />} label="跳过口型" loading={lipsyncBusy} onClick={() => onSkipLipsync?.(shot.id)} />
                    )}
                    {shot.lipsync_skipped && <StatusBadge variant="filled" tone="warning" label="未对口型" size="sm" />}
                </div>
            )}
            <AppDrawer open={activePanel === "history"} onClose={() => setActivePanel(null)} width={480} title={`修订历史 · 镜头 #${shot.idx}`}>
                <div data-testid="shot-revision-history" className="flex flex-col gap-3 p-4 text-xs">
                    {historyLoading && <p className="text-[var(--muted-foreground)]">加载修订历史…</p>}
                    {historyError && <p className="rounded border border-[var(--border)] p-2 text-[var(--danger)]">{historyError}</p>}
                    {!historyLoading && revisions.length === 0 && !historyError && (
                        <p className="text-[var(--muted-foreground)]">暂无修订记录(旧数据可能无历史)</p>
                    )}
                    <ol className="flex flex-col gap-1.5">
                        {revisions.map((rev) => (
                            <li key={rev.id}>
                                <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => void selectRevision(rev.id)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            void selectRevision(rev.id);
                                        }
                                    }}
                                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${selectedRevisionId === rev.id ? "border-[var(--workspace-accent)]" : "border-[var(--border)]"}`}
                                >
                                    <span>
                                        v{rev.version} · {revisionSourceLabel(rev.source)}
                                        <span className="ml-2 text-[var(--muted-foreground)]">{formatRevisionTime(rev.created_at)}</span>
                                    </span>
                                    <ToolButton
                                        size="xs"
                                        variant="ghost"
                                        label="回滚到此版本"
                                        loading={rollingBack}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void rollback(rev.id);
                                        }}
                                    />
                                </div>
                            </li>
                        ))}
                    </ol>
                    {diffLoading && <p className="text-[var(--muted-foreground)]">加载对比…</p>}
                    {diff && (
                        <div data-testid="revision-diff" className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
                            <p className="font-medium text-foreground">
                                v{diff.from_version ?? "?"} → v{diff.version} · {revisionSourceLabel(diff.source)}
                            </p>
                            {diff.from_unknown && <p className="text-[var(--muted-foreground)]">首条修订,无从比较(旧数据基线未知)</p>}
                            {Object.keys(diff.fields).length === 0 && !diff.from_unknown && (
                                <p className="text-[var(--muted-foreground)]">与上游内容一致(无字段变化)</p>
                            )}
                            {Object.entries(diff.fields).map(([field, change]) => (
                                <div key={field} className="flex flex-col gap-0.5">
                                    <p className="font-medium text-foreground">{revisionFieldLabel(field)}</p>
                                    <p className="break-words text-[var(--danger)] line-through">{(change.from ?? "").toString() || "—"}</p>
                                    <p className="break-words text-foreground">{(change.to ?? "").toString() || "—"}</p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </AppDrawer>
            <AppDrawer open={activePanel === "recipes"} onClose={() => setActivePanel(null)} width={480} title={`配方 · 镜头 #${shot.idx}`}>
                <div className="p-4">
                    <ShotRecipePanel
                        shot={shot}
                        busy={busy}
                        onSaved={onSaved}
                        onError={onError}
                        onApplyRender={onApplyRender}
                    />
                </div>
            </AppDrawer>
            <AppDrawer open={activePanel === "compare"} onClose={() => setActivePanel(null)} width={960} title={`候选对比 · 镜头 #${shot.idx}`}>
                <TakeComparePanel shot={shot} busy={busy} onSaved={onSaved} onError={onError} />
            </AppDrawer>
        </>
    );
}
