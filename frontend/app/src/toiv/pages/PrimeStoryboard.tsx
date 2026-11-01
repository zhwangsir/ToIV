import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { loadPrimeStoryboard, savePrimeShotPrompt, savePrimeShotBeats, pickPrimeTake, primeTakeMediaUrl,
    type PrimeMediaStatus, type PrimeShotCard, type PrimeStoryboardModel } from "../adapters/storyboard";
import { estimatePrimeBatch, estimatePrimeShot, estimateAllowsDirectSubmit, submitPrimeBatch, submitPrimeShot,
    type PrimeRenderEstimate, type PrimeRenderOptions, type PrimeRenderScope } from "../adapters/render";
import { assemblePrimeProject, lipsyncPrimeShot, skipPrimeLipsync, synthesizePrimeVoice } from "../adapters/production";
import { rollbackPrimeShot } from "../adapters/revisions";
import { PRIME_STAGES, firstBlockingStage, stageActions, transitionPrimeStage,
    type PrimeStageAction, type PrimeStageId, type PrimeStageState } from "../adapters/stages";
import { RecipePanelPrime } from "../addons/RecipePanelPrime";
import RenderQuoteDialog, { type PrimeQuoteState } from "../addons/RenderQuoteDialog";
import RevisionDrawer from "../addons/RevisionDrawer";
import TakeCompareDialog from "../addons/TakeCompareDialog";
import { ToivWorkbar, type PrimeFace } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

const FACE_HREF: Record<PrimeFace, string> = { pipeline: "/studio", canvas: "/drama", edit: "/studio" };
const STAGE_STATE_LABEL: Record<PrimeStageState, string> = {
    draft: "未开始", pending_confirmation: "待确认", confirmed: "已确认",
    generating: "进行中", failed: "失败", needs_review: "需复核", skipped: "已跳过",
};
const stageLabel = (id: PrimeStageId) => PRIME_STAGES.find(stage => stage.id === id)?.label ?? id;
const MEDIA_LABEL: Record<PrimeMediaStatus, string> = {
    none: "未生成", unknown: "未归档", current: "已同步", stale: "已过期",
};
const MAX_COMPARE = 4;
const renderKey = (scope: PrimeRenderScope, shot?: PrimeShotCard) => scope === "batch" ? "batch" : `shot:${shot?.id ?? ""}`;
type Draft = { base: PrimeShotCard; prompt: string; texts: string[]; totalSec: string };
const draftFor = (shot: PrimeShotCard): Draft => ({ base: shot, prompt: shot.prompt, texts: shot.beats.map(b => b.text), totalSec: String(shot.durationSec) });
const isDirty = (draft: Draft) => draft.base.beats.length
    ? draft.totalSec !== String(draft.base.durationSec) || draft.texts.some((text, i) => text !== draft.base.beats[i].text)
    : draft.prompt !== draft.base.prompt;
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";

export default function PrimeStoryboard() {
    const { id = "" } = useParams();
    return <Storyboard key={id} id={id} />;
}
function Storyboard({ id }: { id: string }) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const focusShotId = searchParams.get("shot") ?? "";
    const [model, setModel] = useState<PrimeStoryboardModel | null>(null);
    const [failed, setFailed] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [tab, setTab] = useState<"shots" | "recipes">("shots");
    const [selectedStage, setSelectedStage] = useState<PrimeStageId | null>(null);
    const [quote, setQuote] = useState<PrimeQuoteState | null>(null);
    const [renderBusy, setRenderBusy] = useState(false);
    const [transitionBusy, setTransitionBusy] = useState(false);
    const [skipStage, setSkipStage] = useState<PrimeStageId | null>(null);
    const [skipNote, setSkipNote] = useState("");
    const [candidateCounts, setCandidateCounts] = useState<Record<string, number>>({});
    const [shortlists, setShortlists] = useState<Record<string, string[]>>({});
    const [revisionShotId, setRevisionShotId] = useState<string | null>(null);
    const [compareShotId, setCompareShotId] = useState<string | null>(null);
    const [skipLipsyncId, setSkipLipsyncId] = useState<string | null>(null);
    const [assembleOpen, setAssembleOpen] = useState(false);
    const [assembleError, setAssembleError] = useState("");
    const pending = useRef(false);
    const renderPending = useRef(false);
    const transitionPending = useRef(false);
    const alive = useRef(true);
    const quoteSeq = useRef(0);
    const quoteAbort = useRef<AbortController | null>(null);
    const renderLocks = useRef<Map<string, string>>(new Map());
    const lastSubmitAt = useRef<Map<string, number>>(new Map());
    const pollTimer = useRef<number | null>(null);
    const focusHandled = useRef("");
    const hasDrafts = Object.keys(drafts).length > 0;

    function stopPolling() {
        if (pollTimer.current !== null) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
        }
    }
    useEffect(() => {
        alive.current = true;
        loadPrimeStoryboard(id).then(next => { if (alive.current) setModel(next); }).catch(error => {
            if (alive.current) { setFailed(true); setNotice(errorText(error)); }
        });
        return () => {
            alive.current = false;
            stopPolling();
            quoteAbort.current?.abort();
            quoteSeq.current += 1;
        };
    }, [id]);
    useEffect(() => {
        if (!hasDrafts) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [hasDrafts]);
    useEffect(() => {
        if (!focusShotId || !model || focusHandled.current === focusShotId) return;
        const target = document.getElementById(`shot-${focusShotId}`);
        if (!target) return;
        focusHandled.current = focusShotId;
        const reduced = document.documentElement.dataset.motion === "reduced"
            || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
        target.focus({ preventScroll: true });
    }, [focusShotId, model]);
    const begin = () => {
        if (pending.current) return false;
        pending.current = true;
        setBusy(true);
        setNotice("");
        return true;
    };
    const finish = () => {
        pending.current = false;
        if (alive.current) setBusy(false);
    };
    const discard = (shotId: string) => setDrafts(prev => {
        const next = { ...prev }; delete next[shotId]; return next;
    });
    const edit = (shot: PrimeShotCard, patch: Partial<Pick<Draft, "prompt" | "texts" | "totalSec">>) => {
        setDrafts(prev => {
            const next = { ...prev };
            const draft = { ...(prev[shot.id] ?? draftFor(shot)), ...patch };
            if (isDirty(draft)) next[shot.id] = draft;
            else delete next[shot.id];
            return next;
        });
    };
    const refresh = async () => {
        if (!begin()) return;
        try {
            const next = await loadPrimeStoryboard(id);
            if (alive.current) {
                setModel(next); setFailed(false);
                setNotice(hasDrafts ? "已刷新；本地草稿和原修订基线仍保留。冲突时请先复制草稿，再放弃本地修改并重新编辑。" : "已刷新分镜");
            }
        } catch (error) { if (alive.current) setNotice(errorText(error)); }
        finally { finish(); }
    };
    async function loadLatest(): Promise<PrimeStoryboardModel | null> {
        try {
            const next = await loadPrimeStoryboard(id);
            if (alive.current && !pending.current) {
                setModel(next); setFailed(false);
                return next;
            }
        } catch { /* silent refresh keeps the last server truth on screen */ }
        return null;
    }
    function startPolling() {
        stopPolling();
        let attempts = 0;
        pollTimer.current = window.setInterval(() => {
            attempts += 1;
            if (!alive.current || attempts > 48) { stopPolling(); return; }
            if (document.visibilityState === "hidden") return;
            void loadLatest().then(next => {
                if (!alive.current) { stopPolling(); return; }
                if (next && attempts >= 3 && next.runningCount === 0) stopPolling();
            });
        }, 5000);
    }
    const save = async (shotId: string) => {
        const draft = drafts[shotId];
        if (!model || !draft || !isDirty(draft) || !begin()) return;
        // A refresh or another shot's save must not rebase unsaved drafts onto a newer revision.
        const snapshot = { ...model, shots: model.shots.map(s => drafts[s.id]?.base ?? s) };
        try {
            const next = draft.base.beats.length
                ? await savePrimeShotBeats(snapshot, shotId, draft.texts, Number(draft.totalSec))
                : await savePrimeShotPrompt(snapshot, shotId, draft.prompt);
            if (alive.current) {
                setModel(next); discard(shotId);
                setNotice(`已保存 ${draft.base.title}${draft.base.beats.length ? " 并重排拍文本" : " 提示词"}`);
            }
        } catch (error) { if (alive.current) setNotice(`保存未完成 · ${errorText(error)}`); }
        finally { finish(); }
    };
    const pick = async (shot: PrimeShotCard, takeId: string) => {
        const take = shot.takes.find(t => t.id === takeId);
        if (!take || take.picked || take.status !== "done" || !take.src?.trim() || !begin()) return;
        try {
            const saved = await pickPrimeTake(shot, takeId);
            if (alive.current) {
                setModel(prev => prev ? { ...prev, shots: prev.shots.map(s => s.id === saved.id ? saved : s) } : prev);
                setNotice(`已采用 ${shot.title} ${take.label}`);
            }
        } catch (error) { if (alive.current) setNotice(`采用失败 · ${errorText(error)}`); }
        finally { finish(); }
    };
    const toggleShortlist = (shotId: string, takeId: string) => setShortlists(prev => {
        const list = prev[shotId] ?? [];
        const next = list.includes(takeId) ? list.filter(id => id !== takeId)
            : list.length >= MAX_COMPARE ? list : [...list, takeId];
        return { ...prev, [shotId]: next };
    });
    const rollback = async (revisionId: string, version: number): Promise<boolean> => {
        const target = model?.shots.find(shot => shot.id === revisionShotId);
        if (!target || !begin()) return false;
        try {
            await rollbackPrimeShot(target.id, revisionId, target.revisionId);
            if (!alive.current) return true;
            setRevisionShotId(null);
            try {
                const next = await loadPrimeStoryboard(id);
                if (alive.current) { setModel(next); setFailed(false); }
            } catch (error) {
                setNotice(`已回滚到 v${version}，但回读失败 · ${errorText(error)}；请刷新核对`);
                return true;
            }
            setNotice(`已回滚到 v${version}；历史保留，下游阶段确认已失效`);
            return true;
        } catch (error) {
            if (alive.current) setNotice(`回滚未完成 · ${errorText(error)}`);
            return false;
        } finally { finish(); }
    };
    const runShotAction = async (shot: PrimeShotCard, action: "voice" | "lipsync" | "skip") => {
        if (!begin()) return;
        const index = Math.max(0, model?.shots.findIndex(item => item.id === shot.id) ?? 0);
        const label = action === "voice" ? "配音" : action === "lipsync" ? "对口型" : "跳过对口型";
        try {
            const saved = action === "voice" ? await synthesizePrimeVoice(shot.id, index, shot.title)
                : action === "lipsync" ? await lipsyncPrimeShot(shot.id, index, shot.title)
                : await skipPrimeLipsync(shot.id, index, shot.title);
            if (!alive.current) return;
            setModel(prev => prev ? { ...prev, shots: prev.shots.map(item => item.id === saved.id ? saved : item) } : prev);
            setSkipLipsyncId(null);
            setNotice(action === "voice" ? `${shot.title} 配音完成`
                : action === "lipsync" ? `${shot.title} 对口型完成`
                : `${shot.title} 已跳过对口型，成片标注未对口型`);
            try {
                const next = await loadPrimeStoryboard(id);
                if (alive.current) setModel(next);
            } catch { /* the local projection already reflects the action */ }
        } catch (error) {
            if (alive.current) setNotice(`${label}未完成 · ${errorText(error)}`);
        } finally { finish(); }
    };
    const assemble = async () => {
        if (!model || !begin()) return;
        setAssembleError("");
        try {
            const next = await assemblePrimeProject(id);
            if (!alive.current) return;
            setModel(next);
            setAssembleOpen(false);
            setNotice(next.finalUrl ? "成片已合成，可在顶部查看" : "合成已完成，但服务端未返回成片地址；请刷新核对");
        } catch (error) {
            if (alive.current) setAssembleError(errorText(error));
        } finally { finish(); }
    };
    const closeQuote = () => {
        quoteSeq.current += 1;
        quoteAbort.current?.abort();
        setQuote(null);
    };
    const fetchQuote = async (scope: PrimeRenderScope, shot: PrimeShotCard | undefined, options: PrimeRenderOptions) => {
        quoteAbort.current?.abort();
        const controller = new AbortController();
        quoteAbort.current = controller;
        const sequence = ++quoteSeq.current;
        setQuote({ scope, shot, options, phase: "loading", estimate: null, error: "", submitting: false, submitError: "" });
        try {
            const estimate = scope === "batch"
                ? await estimatePrimeBatch(id, options, controller.signal)
                : await estimatePrimeShot(shot!.id, options, controller.signal);
            if (!alive.current || sequence !== quoteSeq.current) return;
            setQuote({ scope, shot, options, phase: "ready", estimate, error: "", submitting: false, submitError: "" });
        } catch (error) {
            if (!alive.current || sequence !== quoteSeq.current || controller.signal.aborted) return;
            setQuote({ scope, shot, options, phase: "error", estimate: null, error: errorText(error), submitting: false, submitError: "" });
        }
    };
    const submitRender = async (scope: PrimeRenderScope, shot: PrimeShotCard | undefined, options: PrimeRenderOptions,
        estimate: PrimeRenderEstimate, fromDialog: boolean) => {
        try {
            const result = scope === "batch" ? await submitPrimeBatch(id, options) : await submitPrimeShot(shot!.id, options);
            const key = renderKey(scope, shot);
            renderLocks.current.set(key, estimate.fingerprint);
            lastSubmitAt.current.set(key, Date.now());
            if (!alive.current) return;
            setQuote(null);
            setNotice(`${scope === "batch" ? "整批渲染" : `${shot!.title} 渲染`}已入后台 · 作业 ${result.jobId.slice(0, 8)}，可在任务中心跟进`);
            void loadLatest();
            startPolling();
        } catch (error) {
            if (!alive.current) return;
            if (fromDialog) {
                setQuote(prev => prev ? { ...prev, submitting: false, submitError: errorText(error) } : prev);
            } else {
                setQuote({ scope, shot, options, phase: "ready", estimate, error: "", submitting: false, submitError: errorText(error) });
            }
        }
    };
    const openRender = async (shot?: PrimeShotCard) => {
        if (!model || renderPending.current) return;
        if (!shot && model.runningCount > 0) {
            setNotice("有镜头渲染中，完成后再批量渲染，避免重复排队");
            return;
        }
        const scope: PrimeRenderScope = shot ? "shot" : "batch";
        const options: PrimeRenderOptions = shot ? { numCandidates: candidateCounts[shot.id] ?? 2 } : {};
        const key = renderKey(scope, shot);
        const locked = renderLocks.current.get(key) ?? null;
        const recentlySubmitted = Date.now() - (lastSubmitAt.current.get(key) ?? 0) < 30_000;
        renderPending.current = true;
        setRenderBusy(true);
        setNotice("");
        try {
            const estimate = shot ? await estimatePrimeShot(shot.id, options) : await estimatePrimeBatch(id, options);
            if (!alive.current) return;
            if (!recentlySubmitted && estimateAllowsDirectSubmit(estimate, locked)) {
                await submitRender(scope, shot, options, estimate, false);
                return;
            }
            setQuote({ scope, shot, options, phase: "ready", estimate, error: "", submitting: false, submitError: "" });
        } catch (error) {
            if (!alive.current) return;
            setQuote({ scope, shot, options, phase: "error", estimate: null, error: errorText(error), submitting: false, submitError: "" });
        } finally {
            renderPending.current = false;
            if (alive.current) setRenderBusy(false);
        }
    };
    const confirmQuote = async () => {
        if (!quote || quote.phase !== "ready" || !quote.estimate || quote.submitting) return;
        if (!quote.estimate.allowed || quote.estimate.work.shotCount === 0) return;
        setQuote(prev => prev ? { ...prev, submitting: true, submitError: "" } : prev);
        await submitRender(quote.scope, quote.shot, quote.options, quote.estimate, true);
    };
    const runStageAction = async (stage: PrimeStageId, action: PrimeStageAction, note = "") => {
        if (transitionPending.current) return;
        const revision = model?.stages?.revision;
        if (revision === null || revision === undefined) {
            setNotice("服务端未提供阶段修订号，阶段操作已停用；请刷新或升级后端后再试");
            return;
        }
        transitionPending.current = true;
        setTransitionBusy(true);
        setNotice("");
        try {
            const projection = await transitionPrimeStage(id, { stage, action, note, expectingRevision: revision });
            if (!alive.current) return;
            setModel(prev => prev ? { ...prev, stages: projection } : prev);
            setSkipStage(null);
            setSkipNote("");
            setNotice(action === "confirm" ? "阶段已确认" : action === "skip" ? "阶段已跳过；可在阶段导轨重开" : "阶段已重开，相关下游确认已失效");
        } catch (error) {
            if (!alive.current) return;
            setNotice(`阶段操作未完成 · ${errorText(error)}`);
            if ((error as { status?: number }).status === 409) void loadLatest();
        } finally {
            transitionPending.current = false;
            if (alive.current) setTransitionBusy(false);
        }
    };
    // If another editor deletes a shot, keep its local text visible and copyable until explicitly discarded.
    const visibleShots = [...(model?.shots ?? []), ...Object.values(drafts).filter(d => !model?.shots.some(s => s.id === d.base.id)).map(d => d.base)];
    const stages = model?.stages ?? null;
    const revisionMissing = Boolean(stages) && stages!.revision === null;
    const blocking = stages ? firstBlockingStage(stages.states) : null;
    const selectedEntry = stages && selectedStage ? stages.states[selectedStage] : null;
    const selectedActions = selectedEntry ? stageActions(selectedEntry) : null;
    const selectedIndex = selectedStage ? PRIME_STAGES.findIndex(stage => stage.id === selectedStage) : -1;
    const priorOpen = stages && selectedIndex > 0
        ? PRIME_STAGES.slice(0, selectedIndex).filter(stage => !["confirmed", "skipped"].includes(stages.states[stage.id].state))
        : [];
    const actionReason = (blocked: string) => revisionMissing ? "服务端未提供阶段修订号，无法安全操作；请刷新或升级后端" : blocked;
    const confirmReason = !selectedActions?.canConfirm ? "当前状态不可确认"
        : !selectedEntry!.ready ? `仍有 ${selectedEntry!.blockers.length} 项阻断`
        : priorOpen.length ? `请先确认或跳过 ${priorOpen.map(stage => stage.label).join("、")}` : "";
    const skipReason = !selectedActions?.canSkip ? "当前状态不可跳过" : "";
    const reopenReason = !selectedActions?.canReopen ? "当前状态不可重开" : "";
    const pendingShots = model ? model.shots.filter(shot => shot.status !== "done").length : 0;
    const batchReason = !model ? "正在载入"
        : renderBusy ? "正在核价或提交"
        : model.runningCount > 0 ? "有镜头渲染中，完成后再批量渲染"
        : pendingShots === 0 ? "没有待渲染镜头" : "";
    const revisionShot = model?.shots.find(shot => shot.id === revisionShotId) ?? null;
    const compareShot = model?.shots.find(shot => shot.id === compareShotId) ?? null;
    const skipLipsyncShot = model?.shots.find(shot => shot.id === skipLipsyncId) ?? null;
    const compareIds = compareShot
        ? (shortlists[compareShot.id] ?? []).filter(id => compareShot.takes.some(take =>
            take.id === id && take.status === "done" && Boolean(take.src?.trim())))
        : [];
    const voiceEntry = stages?.states.voice ?? null;
    const voiceOpen = Boolean(voiceEntry && !["confirmed", "skipped"].includes(voiceEntry.state));
    const finalMissing = model ? model.shots.filter(shot => !shot.finalClipUrl.trim()) : [];
    const finalStale = model ? model.shots.filter(shot => shot.media.final === "stale") : [];
    const assembleBlockers = !model ? ["项目正在载入"]
        : !model.stages ? ["阶段数据缺失，无法核对配音门禁；请刷新"]
        : model.shots.length === 0 ? ["项目暂无分镜"]
        : [
            ...(voiceOpen ? ["配音阶段尚未确认或跳过"] : []),
            ...(finalMissing.length ? [`${finalMissing.length} 个镜头缺少最终片段`] : []),
            ...(finalStale.length ? [`${finalStale.length} 个镜头成片已过期`] : []),
        ];
    const canAssemble = assembleBlockers.length === 0;
    const voiceLine = !voiceEntry ? "阶段数据缺失"
        : voiceOpen ? `尚未确认或跳过 · ${STAGE_STATE_LABEL[voiceEntry.state]}` : STAGE_STATE_LABEL[voiceEntry.state];
    return (
        <ToivShell>
            <ToivWorkbar face="pipeline"
                onFaceChange={(face) => navigate(face === "edit" ? `/studio/${id}/editor` : FACE_HREF[face])}
                onOpenTasks={() => navigate("/tasks")} />
            <section className="toiv-shots" aria-busy={busy || renderBusy || transitionBusy}>
                <header className="toiv-shots-bar">
                    <h2>{model?.title ?? (failed ? "载入失败" : "载入中")}</h2>
                    <span className="meta">{model ? `${model.shots.length} 镜${model.runningCount > 0 ? ` · ${model.runningCount} 渲染中` : ""}` : "正在载入"}</span>
                    <Button variant="lime" disabled={Boolean(batchReason)} title={batchReason || undefined}
                        onClick={() => void openRender()}>{renderBusy ? "核价中…" : "整批渲染"}</Button>
                    <Button variant="outline" disabled={busy || !model} title={!model ? "正在载入" : undefined}
                        onClick={() => { setAssembleError(""); setAssembleOpen(true); }}>合成成片</Button>
                    <Button className="toiv-shots-refresh" variant="outline" disabled={busy} onClick={() => void refresh()}>刷新分镜</Button>
                </header>
                {model?.finalUrl ? (
                    <p className="toiv-final" role="group" aria-label="项目成片">
                        <span>成片已就绪</span>
                        <a className="toiv-final-link" href={primeTakeMediaUrl(model.finalUrl)} target="_blank" rel="noreferrer">查看成片</a>
                        {model.projectStatus === "error" ? <span className="toiv-final-warn">上次合成失败，可调整后重试</span> : null}
                    </p>
                ) : null}
                <div className="toiv-seg" role="group" aria-label="分镜面板">
                    <Button variant={tab === "shots" ? "lime" : "ghost"} disabled={busy} aria-pressed={tab === "shots"} onClick={() => setTab("shots")}>分镜</Button>
                    <Button variant={tab === "recipes" ? "lime" : "ghost"} disabled={busy} aria-pressed={tab === "recipes"} onClick={() => setTab("recipes")}>配方</Button>
                </div>
                <p className="meta">渲染会先核价再入后台；任务中心可跟进作业。编辑与保存不会自动触发生成。</p>
                {stages ? (
                    <section className="toiv-stages" aria-label="制作阶段">
                        <header className="toiv-stages-head">
                            <b>制作阶段</b>
                            <span className="meta">{revisionMissing ? "修订号缺失，阶段操作已停用" : `修订 r${stages.revision}`}</span>
                            <span className="meta">{blocking ? `下一步 · ${stageLabel(blocking)}` : "全部阶段已确认或跳过"}</span>
                        </header>
                        {revisionMissing ? <p className="toiv-stages-warn" role="status">服务端未提供阶段修订号；确认、跳过、重开均不会提交。</p> : null}
                        <div className="toiv-stage-rail">
                            {PRIME_STAGES.map((stage, index) => {
                                const entry = stages.states[stage.id];
                                const selected = selectedStage === stage.id;
                                return (
                                    <button key={stage.id} type="button" className={`toiv-stage-chip st-${entry.state}${selected ? " is-selected" : ""}`}
                                        aria-pressed={selected} aria-label={`${stage.label}阶段 · ${STAGE_STATE_LABEL[entry.state]}`}
                                        onClick={() => setSelectedStage(selected ? null : stage.id)}>
                                        <span className="n">{String(index + 1).padStart(2, "0")}</span>
                                        <span className="name">{stage.label}</span>
                                        <span className="state">{STAGE_STATE_LABEL[entry.state]}</span>
                                        {entry.blockers.length ? <span className="blocked">{entry.blockers.length} 项待办</span> : null}
                                    </button>
                                );
                            })}
                        </div>
                        {selectedStage && selectedEntry ? (
                            <div className="toiv-stage-panel">
                                <header>
                                    <b>{stageLabel(selectedStage)}</b>
                                    <span className="meta">{STAGE_STATE_LABEL[selectedEntry.state]} · {selectedEntry.ready ? "已就绪" : "未就绪"}</span>
                                </header>
                                {selectedEntry.blockers.length ? (
                                    <ul className="toiv-stage-blockers" aria-label={`${stageLabel(selectedStage)}阻断项`}>
                                        {selectedEntry.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
                                    </ul>
                                ) : <p className="meta">无阻断项。阶段操作以服务端校验为准。</p>}
                                <div className="toiv-stage-actions">
                                    <Button size="sm" variant="lime" disabled={revisionMissing || Boolean(confirmReason) || transitionBusy}
                                        title={actionReason(confirmReason) || undefined}
                                        onClick={() => void runStageAction(selectedStage, "confirm")}>确认阶段</Button>
                                    <Button size="sm" variant="outline" disabled={revisionMissing || Boolean(skipReason) || transitionBusy}
                                        title={actionReason(skipReason) || undefined}
                                        onClick={() => { setSkipStage(selectedStage); setSkipNote(""); }}>跳过…</Button>
                                    <Button size="sm" variant="ghost" disabled={revisionMissing || Boolean(reopenReason) || transitionBusy}
                                        title={actionReason(reopenReason) || undefined}
                                        onClick={() => void runStageAction(selectedStage, "reopen")}>重开</Button>
                                    {transitionBusy ? <span className="meta">正在提交阶段操作…</span> : null}
                                </div>
                            </div>
                        ) : null}
                    </section>
                ) : null}
                {hasDrafts ? <p className="meta">有未保存修改；切换面板保留草稿，离开页面前请保存或复制。</p> : null}
                {failed ? <div className="toiv-empty"><p>分镜载入失败 · 可刷新重试</p><Button variant="lime" onClick={() => navigate("/studio")}>回项目库</Button></div> : null}
                {notice ? <p className="toiv-saved" role="status">{notice}</p> : null}
                {tab === "recipes" ? <RecipePanelPrime shotId={model?.shots[0]?.id} shotRevisionId={model?.shots[0]?.revisionId} onNotice={setNotice} onApplied={() => { void loadLatest(); }} /> : null}
                {tab === "shots" && model && !visibleShots.length ? <p className="toiv-empty">暂无分镜；本页不会自动生成镜头。</p> : null}
                {tab === "shots" ? visibleShots.map(shot => {
                    const draft = drafts[shot.id] ?? draftFor(shot);
                    const dirty = Boolean(drafts[shot.id]);
                    const missing = !model?.shots.some(s => s.id === shot.id);
                    const count = candidateCounts[shot.id] ?? 2;
                    const shotReason = missing ? "该镜头已不在服务端" : shot.status === "run" ? "渲染进行中"
                        : renderBusy ? "正在核价或提交" : busy ? "正在保存或刷新" : "";
                    const selectedTakes = (shortlists[shot.id] ?? []).filter(id => shot.takes.some(take =>
                        take.id === id && take.status === "done" && Boolean(take.src?.trim())));
                    const selectedCount = selectedTakes.length;
                    const productionBusy = busy || missing || shot.status === "run";
                    const productionIdle = productionBusy ? (missing ? "该镜头已不在服务端" : shot.status === "run" ? "渲染进行中" : "正在处理其他操作") : "";
                    const voiceReason = productionIdle || (!shot.dialogue.trim() ? "该镜无台词" : "");
                    const lipsyncReason = productionIdle || (!shot.videoUrl ? "需先生成视频" : !shot.voiceUrl ? "需先配音" : "");
                    const skipLipsyncReason = productionIdle || (!shot.voiceUrl ? "需先配音" : "");
                    return (
                        <article className={`toiv-shot st-${shot.status}${shot.id === focusShotId ? " is-focused" : ""}`}
                            id={`shot-${shot.id}`} key={shot.id} tabIndex={-1}>
                            <header>
                                <b>{shot.title}</b><span className="meta">{shot.camera} · {shot.durationSec}s</span>
                                <span className={`flag flag-${shot.status}`}>{shot.status === "done" ? "完成" : shot.status === "run" ? "渲染中" : shot.status === "error" ? "失败" : "排队"}</span>
                            </header>
                            {shot.error ? <p role="alert">{shot.error}</p> : null}
                            {missing ? <p role="alert">该镜头已不在服务端列表中，本地草稿仍保留供复制。</p> : null}
                            <div className="toiv-shot-media" aria-label={`${shot.title} 产物状态`}>
                                {(["visual", "audio", "final"] as const).map(line => (
                                    <span key={line} className={`toiv-media st-${shot.media[line]}`}>
                                        {line === "visual" ? "视觉" : line === "audio" ? "配音" : "成片"} · {MEDIA_LABEL[shot.media[line]]}
                                    </span>
                                ))}
                                {shot.lipsyncSkipped ? <span className="toiv-media st-skipped">未对口型</span> : null}
                            </div>
                            {shot.media.visual === "stale" ? <p className="toiv-stale-hint">视觉输入已变更，当前画面/视频已过期；重渲染后恢复同步。</p> : null}
                            {shot.media.audio === "stale" ? <p className="toiv-stale-hint">台词或音色已变更，配音已过期；重新配音后恢复同步。</p> : null}
                            {shot.media.final === "stale" ? <p className="toiv-stale-hint">最终片段已过期；重新对口型或重渲染后再合成。</p> : null}
                            <p className="toiv-dialogue">
                                {shot.dialogue.trim()
                                    ? <><span className="who">{shot.speaker || "旁白"}</span>「{shot.dialogue}」</>
                                    : <span className="meta">本镜无台词</span>}
                                {shot.media.audio === "stale" ? <span className="toiv-stale-tag">台词已变 · 配音过期</span> : null}
                            </p>
                            {draft.base.beats.length ? <>
                                <div className="toiv-beats">{draft.base.beats.map((beat, index) => (
                                    <label className="toiv-prompt" key={index}>第 {index + 1} 拍 · {beat.kind === "v" ? "画面" : beat.kind === "d" ? "对白" : "未标通道"}
                                        <textarea aria-label={`第 ${index + 1} 拍文本`} rows={2} value={draft.texts[index]} disabled={busy}
                                            onChange={event => edit(shot, { texts: draft.texts.map((text, i) => i === index ? event.target.value : text) })} />
                                    </label>
                                ))}</div>
                                <label className="toiv-prompt">总时长（秒）<input type="number" min={3} max={60} step={1} value={draft.totalSec} disabled={busy}
                                    onChange={event => edit(shot, { totalSec: event.target.value })} /></label>
                                <label className="toiv-prompt">派生提示词<textarea rows={3} value={shot.prompt} readOnly /></label>
                                <p className="meta">按拍文本为真源；保存后重排并回读派生内容，不增删拍。</p>
                            </> : <label className="toiv-prompt">提示词
                                <textarea rows={3} value={draft.prompt} disabled={busy} onChange={event => edit(shot, { prompt: event.target.value })} />
                            </label>}
                            <div className="toiv-seg">
                                <Button variant="lime" disabled={!dirty || busy || missing} onClick={() => void save(shot.id)}>{draft.base.beats.length ? "保存并重排" : "保存提示词"}</Button>
                                {dirty ? <><span className="meta">未保存</span><Button variant="ghost" disabled={busy} onClick={() => discard(shot.id)}>放弃本地修改</Button></> : null}
                            </div>
                            <div className="toiv-shot-render">
                                <label className="toiv-render-count">候选数
                                    <select aria-label={`${shot.title} 候选数`} value={count} disabled={busy || renderBusy}
                                        onChange={event => setCandidateCounts(prev => ({ ...prev, [shot.id]: Number(event.target.value) }))}>
                                        {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}
                                    </select>
                                </label>
                                <Button size="sm" variant={shot.status === "error" ? "lime" : "outline"} disabled={Boolean(shotReason)}
                                    title={shotReason || undefined} onClick={() => void openRender(shot)}>
                                    {shot.status === "error" ? "重试渲染" : "渲染此镜"}
                                </Button>
                                <span className="meta">先核价再提交；候选默认 {count} 条，异步入后台。</span>
                            </div>
                            <div className="toiv-shot-production" role="group" aria-label={`${shot.title} 配音与成片`}>
                                <Button size="sm" variant={shot.voiceUrl ? "outline" : "lime"} disabled={Boolean(voiceReason)}
                                    title={voiceReason || undefined} onClick={() => void runShotAction(shot, "voice")}>
                                    {shot.voiceUrl ? "重新配音" : "配音"}
                                </Button>
                                {shot.renderMode === "video" ? <>
                                    <Button size="sm" variant="outline" disabled={Boolean(lipsyncReason)} title={lipsyncReason || undefined}
                                        onClick={() => void runShotAction(shot, "lipsync")}>
                                        {shot.finalClipUrl ? "重新对口型" : "对口型"}
                                    </Button>
                                    <Button size="sm" variant="ghost" disabled={Boolean(skipLipsyncReason)} title={skipLipsyncReason || undefined}
                                        onClick={() => setSkipLipsyncId(shot.id)}>跳过口型…</Button>
                                </> : <span className="meta">图像运镜镜无需对口型</span>}
                                <Button size="sm" variant="ghost" disabled={missing} onClick={() => setRevisionShotId(shot.id)}>修订历史</Button>
                                <span className="meta">{productionIdle || (shot.lipsyncSkipped ? "本镜已标注未对口型；可重新对口型或保持标注" : "配音与对口型会同步更新产物状态。")}</span>
                            </div>
                            <div className="toiv-takes" role="group" aria-label={`${shot.title} 候选 Takes`}>
                                <header className="toiv-takes-head">
                                    <b>候选 Takes</b>
                                    <span className="meta">{selectedCount}/{MAX_COMPARE} 已加入对比</span>
                                    <Button size="sm" variant="outline" disabled={selectedCount < 2}
                                        title={selectedCount < 2 ? "至少选择 2 条已完成候选" : undefined}
                                        onClick={() => setCompareShotId(shot.id)}>对比已选 ({selectedCount})</Button>
                                    {selectedCount ? <Button size="sm" variant="ghost" disabled={busy}
                                        onClick={() => setShortlists(prev => ({ ...prev, [shot.id]: [] }))}>清空对比</Button> : null}
                                </header>
                                {shot.takes.map(take => {
                                    const src = primeTakeMediaUrl(take.src);
                                    const inCompare = selectedTakes.includes(take.id);
                                    const compareReady = take.status === "done" && Boolean(take.src?.trim());
                                    return <section key={take.id} aria-label={`${take.label} 候选比较`}>
                                        <h3>{take.label} · {take.status}{take.picked ? " · 当前采用" : ""}</h3>
                                        {src ? <video width="320" src={src} controls muted playsInline preload="none" aria-label={`${take.label} 预览`} /> : <p className="meta">暂无可预览产物</p>}
                                        <dl>
                                            <dt>候选 ID</dt><dd>{take.id}</dd>
                                            <dt>Seed</dt><dd>{take.seed ?? "未提供"}</dd>
                                            <dt>引擎</dt><dd>{take.videoModel || "未提供"}</dd>
                                            <dt>管线</dt><dd>{take.pipeline || "未提供"}</dd>
                                            <dt>修订</dt><dd>{take.revisionId || "未提供"}</dd>
                                            <dt>QA</dt><dd>{take.qaVerdict || "未提供"}</dd>
                                        </dl>
                                        {take.error ? <p>{take.error}</p> : null}
                                        <div className="toiv-take-actions">
                                            <Button variant={take.picked ? "lime" : "outline"} size="sm" aria-label={`采用 ${take.label}`} aria-pressed={take.picked}
                                                disabled={busy || missing || take.picked || take.status !== "done" || !take.src?.trim() || !shot.candidatesDigest}
                                                onClick={() => void pick(shot, take.id)}>采用 {take.label}</Button>
                                            <Button variant="ghost" size="sm" aria-label={`${inCompare ? "移出对比" : "加入对比"} ${take.label}`}
                                                aria-pressed={inCompare}
                                                disabled={!inCompare && (!compareReady || selectedCount >= MAX_COMPARE)}
                                                title={!compareReady ? "仅已完成且带产物的候选可对比"
                                                    : !inCompare && selectedCount >= MAX_COMPARE ? `最多同时对比 ${MAX_COMPARE} 条` : undefined}
                                                onClick={() => toggleShortlist(shot.id, take.id)}>
                                                {inCompare ? "移出对比" : "加入对比"}
                                            </Button>
                                        </div>
                                    </section>;
                                })}
                                {shot.takes.length === 0 ? <span className="meta">暂无候选</span>
                                    : <p className="meta toiv-takes-note">仅 done 且有产物 URL 的候选可采用；候选变化请刷新。</p>}
                            </div>
                        </article>
                    );
                }) : null}
            </section>
            <RenderQuoteDialog quote={quote} onClose={closeQuote}
                onRetry={() => { if (quote) void fetchQuote(quote.scope, quote.shot, quote.options); }}
                onConfirm={() => void confirmQuote()}
                onFixStage={(stage) => { closeQuote(); setSelectedStage(stage); }} />
            <Modal open={skipStage !== null} dismissible={!transitionBusy}
                onClose={() => { if (!transitionBusy) { setSkipStage(null); setSkipNote(""); } }}
                title={skipStage ? `跳过${stageLabel(skipStage)}阶段` : "跳过阶段"}
                footer={<>
                    <Button variant="ghost" disabled={transitionBusy} onClick={() => { setSkipStage(null); setSkipNote(""); }}>取消</Button>
                    <Button variant="lime" disabled={transitionBusy || skipNote.trim().length < 2}
                        title={skipNote.trim().length < 2 ? "至少填写 2 个字说明" : undefined}
                        onClick={() => { if (skipStage) void runStageAction(skipStage, "skip", skipNote); }}>
                        {transitionBusy ? "提交中…" : "确认跳过"}
                    </Button>
                </>}>
                <label className="toiv-prompt">跳过说明（至少 2 个字）
                    <textarea rows={3} autoFocus aria-label="跳过说明" value={skipNote} disabled={transitionBusy}
                        placeholder="例如：本剧无角色卡，直接进入分镜确认"
                        onChange={event => setSkipNote(event.target.value)} />
                </label>
                <p className="meta">跳过后该阶段不参与就绪判断，可在阶段导轨重开。</p>
            </Modal>
            <RevisionDrawer shot={revisionShot} busy={busy} onClose={() => setRevisionShotId(null)} onRollback={rollback} />
            <TakeCompareDialog shot={compareShot} takeIds={compareIds} busy={busy} onClose={() => setCompareShotId(null)}
                onPick={takeId => { if (compareShot) void pick(compareShot, takeId); }} />
            <Modal open={Boolean(skipLipsyncShot)} dismissible={!busy}
                onClose={() => { if (!busy) setSkipLipsyncId(null); }}
                title={skipLipsyncShot ? `跳过对口型 · ${skipLipsyncShot.title}` : "跳过对口型"}
                footer={<>
                    <Button variant="ghost" disabled={busy} onClick={() => setSkipLipsyncId(null)}>取消</Button>
                    <Button variant="lime" disabled={busy}
                        onClick={() => { if (skipLipsyncShot) void runShotAction(skipLipsyncShot, "skip"); }}>
                        {busy ? "提交中…" : "确认跳过"}
                    </Button>
                </>}>
                <p>跳过后该镜保留当前最终片段并标注「未对口型」；合成时不会因此被拦截，之后可重新对口型。</p>
                <p className="meta">仅视频镜可以跳过；图像运镜镜没有口型环节。</p>
            </Modal>
            <Modal open={assembleOpen} dismissible={!busy} className="toiv-assemble-modal"
                onClose={() => { if (!busy) setAssembleOpen(false); }} title="合成成片"
                footer={<>
                    {voiceEntry && voiceOpen ? <Button variant="outline" disabled={busy}
                        onClick={() => { setAssembleOpen(false); setSelectedStage("voice"); }}>去确认配音阶段</Button> : null}
                    <Button variant="ghost" disabled={busy} onClick={() => setAssembleOpen(false)}>取消</Button>
                    <Button variant="lime" disabled={busy || !canAssemble}
                        title={canAssemble ? undefined : "先处理检查单中的阻断项"}
                        onClick={() => void assemble()}>{busy ? "合成中…" : "开始合成"}</Button>
                </>}>
                <p className="meta">按分镜顺序拼接每镜的最终片段；合格后可在顶部「查看成片」。合成以服务端校验为准。</p>
                <ul className="toiv-assemble-check" aria-label="合成检查单">
                    <li className={!voiceEntry || voiceOpen ? "is-blocked" : "is-ok"}>
                        <b>配音阶段</b><span>{voiceLine}</span>
                    </li>
                    <li className={finalMissing.length ? "is-blocked" : "is-ok"}>
                        <b>最终片段</b>
                        <span>{finalMissing.length ? `${finalMissing.length} 镜缺失 · ${finalMissing.map(shot => shot.title).join("、")}` : "全部到位"}</span>
                    </li>
                    <li className={finalStale.length ? "is-blocked" : "is-ok"}>
                        <b>过期片段</b>
                        <span>{finalStale.length ? `${finalStale.length} 镜过期 · ${finalStale.map(shot => shot.title).join("、")}；请先重做` : "无过期片段"}</span>
                    </li>
                </ul>
                {assembleError ? <p className="toiv-assemble-error" role="alert">{assembleError}</p> : null}
            </Modal>
        </ToivShell>
    );
}
