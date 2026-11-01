import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import {
    clampPrimeDuration, downloadPrimeExport, fetchPrimeExport, formatPrimeTime, loadPrimeEditBay,
    loadPrimeExportPreflight, primeShotStale, projectPrimeEditBay, PRIME_EDIT_TRACKS,
    savePrimeEditDurations,
    type PrimeEditBayModel, type PrimeEditClip, type PrimeEditShot, type PrimeExportKind,
    type PrimeExportPreflight,
} from "../adapters/edit";
import { primeTakeMediaUrl } from "../adapters/storyboard";
import { assemblePrimeProject } from "../adapters/production";
import { ToivWorkbar, type PrimeFace } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

const FACE_HREF: Record<PrimeFace, string> = { pipeline: "/studio", canvas: "/drama", edit: "/studio" };
const STATUS_LABEL: Record<PrimeEditShot["status"], string> = {
    done: "完成", run: "渲染中", wait: "排队", error: "失败",
};
const EXPORT_LABEL: Record<PrimeExportKind, string> = {
    jianying: "剪映草稿", edl: "EDL", fcpxml: "FCPXML", multitrack: "多轨 ZIP",
};
const MEDIA_LABEL: Record<PrimeEditShot["media"]["final"], string> = {
    none: "未生成", unknown: "未归档", current: "已同步", stale: "已过期",
};
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";
type Overrides = Record<string, number>;

export default function PrimeEditor() {
    const { id = "" } = useParams();
    return <EditBay key={id} id={id} />;
}

function EditBay({ id }: { id: string }) {
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeEditBayModel | null>(null);
    const [failed, setFailed] = useState(false);
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [selectedId, setSelectedId] = useState("");
    const [timeSec, setTimeSec] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [overrides, setOverrides] = useState<Overrides>({});
    const [past, setPast] = useState<Overrides[]>([]);
    const [future, setFuture] = useState<Overrides[]>([]);
    const [snap, setSnap] = useState(true);
    const [pxPerSec, setPxPerSec] = useState(48);
    const [exportOpen, setExportOpen] = useState(false);
    const [exportBusy, setExportBusy] = useState<PrimeExportKind | "">("");
    const [preflight, setPreflight] = useState<PrimeExportPreflight | null>(null);
    const [preflightBusy, setPreflightBusy] = useState(false);
    const [durationText, setDurationText] = useState("");
    const [dragging, setDragging] = useState(false);
    const pending = useRef(false);
    const alive = useRef(true);
    const timeRef = useRef(0);
    const totalRef = useRef(0);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const drag = useRef<{ shotId: string; startX: number; base: number; pushed: boolean } | null>(null);
    const preflightAbort = useRef<AbortController | null>(null);

    const projection = model ? projectPrimeEditBay(model, overrides) : null;
    const clips = projection?.clips ?? [];
    const v1Clips = clips.filter(clip => clip.track === "v1");
    const totalSec = projection?.totalSec ?? 0;
    const dirtyIds = projection?.dirty ?? [];
    const missingIssues = projection?.issues.missing ?? [];
    const durationIssues = projection?.issues.duration ?? [];
    const shotsById = new Map((model?.shots ?? []).map(shot => [shot.id, shot]));
    const selectedShot = selectedId ? shotsById.get(selectedId) ?? null : null;
    const selectedClip = selectedShot ? v1Clips.find(clip => clip.shotId === selectedShot.id) ?? null : null;
    const selectedDuration = selectedShot ? overrides[selectedShot.id] ?? selectedShot.durationSec : 0;
    const activeClip = v1Clips.find(clip => timeSec >= clip.startSec - 1e-6 && timeSec < clip.startSec + clip.durationSec - 1e-6)
        ?? v1Clips[v1Clips.length - 1] ?? null;
    const activeShot = activeClip ? shotsById.get(activeClip.shotId) ?? null : null;
    const playerSrc = activeShot ? primeTakeMediaUrl(activeShot.finalClipUrl || activeShot.videoUrl) : "";
    const finalMissing = (model?.shots ?? []).filter(shot => !shot.finalClipUrl.trim());
    const finalStale = (model?.shots ?? []).filter(shot => primeShotStale(shot));
    const finalTarget = finalMissing[0] ?? finalStale[0] ?? null;
    const renderLabel = finalMissing.length ? "补齐缺失片段" : finalStale.length ? "重新渲染成片"
        : model?.finalUrl ? "重新合成成片" : "合成成片";
    const contentWidth = Math.max(320, Math.ceil(totalSec * pxPerSec));
    const hasClips = v1Clips.length > 0;
    const dirtyCount = dirtyIds.length;
    const exportBlocked = dirtyCount > 0 ? "先保存时长再导出，否则服务端仍用旧切点"
        : !hasClips ? "没有可导出的画面片段"
        : preflight?.state === "blocked" ? `服务端拒绝导出：${preflight.detail}`
        : "";

    useEffect(() => {
        alive.current = true;
        setModel(null); setFailed(false); setNotice(""); setPlaying(false);
        setOverrides({}); setPast([]); setFuture([]); setSelectedId("");
        setTimeSec(0); timeRef.current = 0;
        loadPrimeEditBay(id).then(next => {
            if (!alive.current) return;
            setModel(next);
            const first = next.clips.find(clip => clip.track === "v1");
            setSelectedId(first?.shotId ?? next.shots[0]?.id ?? "");
        }).catch(error => {
            if (alive.current) { setFailed(true); setNotice(errorText(error)); }
        });
        return () => {
            alive.current = false;
            preflightAbort.current?.abort();
        };
    }, [id]);

    useEffect(() => {
        totalRef.current = totalSec;
        if (timeRef.current > totalSec) {
            timeRef.current = totalSec;
            setTimeSec(totalSec);
        }
        if (!totalSec) setPlaying(false);
    }, [totalSec]);

    useEffect(() => {
        if (!playing) return;
        const timer = window.setInterval(() => {
            const next = Math.min(totalRef.current, Math.round((timeRef.current + 0.1) * 10) / 10);
            timeRef.current = next;
            setTimeSec(next);
            if (next >= totalRef.current) setPlaying(false);
        }, 100);
        return () => window.clearInterval(timer);
    }, [playing]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (playing) void video.play().catch(() => {});
        else video.pause();
    }, [playing, activeClip?.id]);

    useEffect(() => {
        setDurationText(selectedShot ? String(overrides[selectedShot.id] ?? selectedShot.durationSec) : "");
    }, [selectedShot?.id, selectedShot?.durationSec, overrides, selectedShot]);

    useEffect(() => {
        if (!model || !selectedId) return;
        if (!model.shots.some(shot => shot.id === selectedId)) {
            const first = model.clips.find(clip => clip.track === "v1");
            setSelectedId(first?.shotId ?? model.shots[0]?.id ?? "");
        }
    }, [model, selectedId]);

    useEffect(() => {
        if (!dirtyCount) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirtyCount]);

    function begin(): boolean {
        if (pending.current) return false;
        pending.current = true;
        setBusy(true);
        setNotice("");
        return true;
    }
    function finish() {
        pending.current = false;
        if (alive.current) setBusy(false);
    }
    function cutPoints(): number[] {
        return [...new Set([0, ...v1Clips.flatMap(clip => [clip.startSec, clip.startSec + clip.durationSec])])]
            .map(value => Math.round(value * 1000) / 1000)
            .sort((a, b) => a - b);
    }
    function seek(value: number, allowSnap = snap) {
        let next = Math.max(0, Math.min(totalSec, Number.isFinite(value) ? value : 0));
        if (allowSnap) {
            let best = next;
            let bestDistance = 0.3;
            for (const point of cutPoints()) {
                const distance = Math.abs(point - next);
                if (distance < bestDistance) { best = point; bestDistance = distance; }
            }
            next = best;
        }
        next = Math.round(next * 10) / 10;
        timeRef.current = next;
        setTimeSec(next);
    }
    function seekFromPointer(event: { clientX: number; currentTarget: HTMLElement }) {
        const rect = event.currentTarget.getBoundingClientRect();
        seek((event.clientX - rect.left) / pxPerSec);
    }
    function togglePlay() {
        if (!totalSec) return;
        if (playing) { setPlaying(false); return; }
        if (timeRef.current >= totalSec - 0.01) seek(0, false);
        setPlaying(true);
    }
    function goPrev() {
        if (!v1Clips.length) return;
        const current = v1Clips.find(clip => timeRef.current >= clip.startSec + 0.05
            && timeRef.current < clip.startSec + clip.durationSec - 0.01);
        if (current) { seek(current.startSec, false); return; }
        const before = [...v1Clips].reverse().find(clip => clip.startSec < timeRef.current - 0.05);
        seek((before ?? v1Clips[0]).startSec, false);
    }
    function goNext() {
        if (!v1Clips.length) return;
        const after = v1Clips.find(clip => clip.startSec > timeRef.current + 0.05);
        seek((after ?? v1Clips[v1Clips.length - 1]).startSec, false);
    }
    function selectClip(clip: PrimeEditClip) {
        setSelectedId(clip.shotId);
        seek(clip.startSec, false);
    }
    function locate(shotId: string) {
        setSelectedId(shotId);
        const clip = v1Clips.find(item => item.shotId === shotId);
        if (clip) seek(clip.startSec, false);
    }
    function pushPast() {
        setPast(prev => [...prev.slice(-49), overrides]);
        setFuture([]);
    }
    function setDuration(shot: PrimeEditShot, value: number) {
        const clamped = clampPrimeDuration(shot, value);
        const current = overrides[shot.id] ?? shot.durationSec;
        if (clamped === current) return;
        pushPast();
        setOverrides(prev => {
            const next = { ...prev };
            if (clamped === shot.durationSec) delete next[shot.id];
            else next[shot.id] = clamped;
            return next;
        });
        setDurationText(String(clamped));
    }
    function commitDurationText() {
        if (!selectedShot) return;
        const raw = durationText.trim();
        if (!raw) { setDurationText(String(selectedDuration)); return; }
        const value = Number(raw);
        if (!Number.isInteger(value)) {
            setNotice("时长必须是整数秒");
            setDurationText(String(selectedDuration));
            return;
        }
        const clamped = clampPrimeDuration(selectedShot, value);
        if (clamped !== value) setNotice(`时长按 ${selectedShot.minSec}–${selectedShot.maxSec} 秒范围收敛为 ${clamped}s`);
        setDuration(selectedShot, clamped);
    }
    function undo() {
        if (!past.length) return;
        const previous = past[past.length - 1];
        setPast(past.slice(0, -1));
        setFuture([overrides, ...future]);
        setOverrides(previous);
    }
    function redo() {
        if (!future.length) return;
        const next = future[0];
        setFuture(future.slice(1));
        setPast([...past, overrides]);
        setOverrides(next);
    }
    function startTrim(event: ReactPointerEvent<HTMLSpanElement>) {
        if (!selectedShot || busy) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { shotId: selectedShot.id, startX: event.clientX, base: selectedDuration, pushed: false };
        setDragging(true);
    }
    function moveTrim(event: ReactPointerEvent<HTMLSpanElement>) {
        const state = drag.current;
        const shot = state ? model?.shots.find(item => item.id === state.shotId) : null;
        if (!state || !shot) return;
        const value = clampPrimeDuration(shot, state.base + (event.clientX - state.startX) / pxPerSec);
        if (value === (overrides[shot.id] ?? shot.durationSec)) return;
        if (!state.pushed) {
            state.pushed = true;
            setPast(prev => [...prev.slice(-49), overrides]);
            setFuture([]);
        }
        setOverrides(prev => {
            const next = { ...prev };
            if (value === shot.durationSec) delete next[shot.id];
            else next[shot.id] = value;
            return next;
        });
        setDurationText(String(value));
    }
    function endTrim(event: ReactPointerEvent<HTMLSpanElement>) {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture already gone */ }
    }
    async function refresh() {
        if (!begin()) return;
        try {
            const next = await loadPrimeEditBay(id);
            if (alive.current) {
                setModel(next); setFailed(false);
                setNotice(dirtyCount ? "已刷新；本地未保存时长仍保留。冲突时请先复制草稿再放弃修改。"
                    : "已刷新时间线");
            }
        } catch (error) { if (alive.current) setNotice(errorText(error)); }
        finally { finish(); }
    }
    async function saveDurations() {
        if (!model || !dirtyCount || !begin()) return;
        try {
            const next = await savePrimeEditDurations(model, overrides);
            if (alive.current) {
                setModel(next);
                setOverrides({}); setPast([]); setFuture([]);
                setNotice(`已保存 ${dirtyCount} 镜时长；导出切点已同步`);
                if (exportOpen) void refreshPreflight(next.projectId);
            }
        } catch (error) { if (alive.current) setNotice(`保存未完成 · ${errorText(error)}`); }
        finally { finish(); }
    }
    async function assemble() {
        if (!model || !begin()) return;
        try {
            await assemblePrimeProject(model.projectId);
            const next = await loadPrimeEditBay(model.projectId);
            if (alive.current) {
                setModel(next);
                setNotice(next.finalUrl ? "成片已合成，可查看或导出" : "服务端未返回成片地址 · 请刷新");
            }
        } catch (error) { if (alive.current) setNotice(`合成未完成 · ${errorText(error)}`); }
        finally { finish(); }
    }
    async function refreshPreflight(projectId = model?.projectId) {
        if (!projectId) return;
        preflightAbort.current?.abort();
        const controller = new AbortController();
        preflightAbort.current = controller;
        setPreflightBusy(true);
        try {
            const result = await loadPrimeExportPreflight(projectId, controller.signal);
            if (!controller.signal.aborted) setPreflight(result);
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
            setPreflight({ state: "unknown", missingAssets: null, durationIssues: null, detail: errorText(error) });
        } finally {
            if (!controller.signal.aborted) setPreflightBusy(false);
        }
    }
    function toggleExport() {
        const open = !exportOpen;
        setExportOpen(open);
        if (open) void refreshPreflight();
    }
    async function runExport(kind: PrimeExportKind) {
        if (!model || exportBlocked || exportBusy || busy) return;
        setExportBusy(kind);
        setNotice("");
        try {
            const file = await fetchPrimeExport(model.projectId, kind);
            downloadPrimeExport(file);
            if (alive.current) {
                const receipt = file.missingAssets === null ? "" : ` · 服务端记录缺素材 ${file.missingAssets}`;
                const duration = file.durationIssues ? ` · 时长异常 ${file.durationIssues}` : "";
                setNotice(`已导出 ${EXPORT_LABEL[kind]} · ${file.filename}${receipt}${duration}`);
                if (file.missingAssets !== null || file.durationIssues !== null) {
                    setPreflight({ state: "ok", missingAssets: file.missingAssets ?? 0,
                        durationIssues: file.durationIssues ?? 0, detail: "" });
                }
            }
        } catch (error) { if (alive.current) setNotice(`导出失败 · ${errorText(error)}`); }
        finally { if (alive.current) setExportBusy(""); }
    }
    function openStoryboard(shotId?: string) {
        navigate(`/studio/${id}${shotId ? `?shot=${encodeURIComponent(shotId)}` : ""}`);
    }

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"
                || target.tagName === "SELECT" || target.isContentEditable)) return;
            const key = event.key.toLowerCase();
            if (event.key === " ") { event.preventDefault(); togglePlay(); }
            else if (key === "j") { event.preventDefault(); goPrev(); }
            else if (key === "k") { event.preventDefault(); togglePlay(); }
            else if (key === "l") { event.preventDefault(); goNext(); }
            else if (event.key === "ArrowLeft") { event.preventDefault(); seek(Math.max(0, timeRef.current - 1), false); }
            else if (event.key === "ArrowRight") { event.preventDefault(); seek(Math.min(totalRef.current, timeRef.current + 1), false); }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    });

    return (
        <ToivShell>
            <ToivWorkbar face="edit"
                onFaceChange={(face) => { if (face !== "edit") navigate(FACE_HREF[face]); }}
                onOpenTasks={() => navigate("/tasks")} />
            <section className="toiv-edit" aria-busy={busy || Boolean(exportBusy)}>
                <header className="toiv-shots-bar">
                    <h2>{model?.title ?? (failed ? "载入失败" : "载入中")}</h2>
                    <span className="meta">{model
                        ? `${model.shots.length} 镜 · ${v1Clips.length} 进线 · ${model.fps}fps`
                        : "正在载入"}</span>
                    {model ? (
                        <Button variant={finalTarget || dirtyCount === 0 ? "lime" : "outline"}
                            disabled={busy}
                            title={finalTarget ? "剪辑湾只按已归档片段导出；重新渲染请在流水线完成" : undefined}
                            onClick={() => { if (finalTarget) openStoryboard(finalTarget.id); else void assemble(); }}>
                            {busy ? "处理中…" : renderLabel}
                        </Button>
                    ) : null}
                    {model ? (
                        <Button variant={dirtyCount ? "lime" : "outline"} disabled={!dirtyCount || busy}
                            title={dirtyCount ? "通过分镜写入保存声明时长，导出切点随之更新" : "没有待保存的时长修改"}
                            onClick={() => void saveDurations()}>
                            {busy ? "保存中…" : dirtyCount ? `保存时长 (${dirtyCount})` : "保存时长"}
                        </Button>
                    ) : null}
                    {model ? (
                        <Button variant="outline" aria-expanded={exportOpen} disabled={busy}
                            onClick={toggleExport}>导出</Button>
                    ) : null}
                    <Button variant="outline" className="toiv-shots-refresh" disabled={busy} onClick={() => void refresh()}>刷新时间线</Button>
                </header>
                <p className="toiv-edit-mobile-note">窄屏可预览与切镜；精细裁剪与导出建议在桌面宽屏完成。</p>
                {failed ? (
                    <div className="toiv-empty">
                        <p>时间线载入失败 · 可重试</p>
                        <Button variant="lime" onClick={() => navigate("/studio")}>回项目库</Button>
                    </div>
                ) : null}
                {notice ? <p className="toiv-saved" role="status">{notice}</p> : null}
                {!model && !failed ? <p role="status">正在载入时间线…</p> : null}
                {model && exportOpen ? (
                    <section className="toiv-edit-export" aria-label="导出">
                        <header>
                            <b>导出</b>
                            <span className="meta">切点与流水线同一批分镜；缺素材与时长异常以服务端回执为准。</span>
                            <Button size="sm" variant="ghost" onClick={() => setExportOpen(false)}>收起</Button>
                        </header>
                        <ul className="toiv-edit-check" aria-label="导出前检查">
                            <li className={hasClips ? "is-ok" : "is-blocked"}>
                                <b>画面片段</b>
                                <span>{hasClips ? `${v1Clips.length} 镜已进时间线` : "没有可导出的画面片段"}</span>
                            </li>
                            <li className={dirtyCount ? "is-blocked" : "is-ok"}>
                                <b>本地修改</b>
                                <span>{dirtyCount ? `${dirtyCount} 镜时长未保存；导出会使用服务端旧切点` : "已与服务端同步"}</span>
                            </li>
                            <li className={missingIssues.length ? "is-warn" : "is-ok"}>
                                <b>缺素材</b>
                                <span>{missingIssues.length ? `${missingIssues.length} 镜缺最终片段 · 导出会跳过这些镜头` : "无缺失"}</span>
                            </li>
                            <li className={durationIssues.length ? "is-warn" : "is-ok"}>
                                <b>时长异常</b>
                                <span>{durationIssues.length ? `${durationIssues.length} 镜声明时长异常 · 切点按服务端规则处理` : "无异常"}</span>
                            </li>
                            <li className={preflight?.state === "ok" ? "is-ok" : preflight?.state === "blocked" ? "is-blocked" : "is-warn"}>
                                <b>服务端核验</b>
                                <span>{preflightBusy ? "核验中…"
                                    : !preflight ? "尚未核验"
                                    : preflight.state === "ok" ? `缺素材 ${preflight.missingAssets} · 时长异常 ${preflight.durationIssues}`
                                    : `${preflight.state === "blocked" ? "导出被拒绝" : "未确认"} · ${preflight.detail}`}</span>
                            </li>
                        </ul>
                        {missingIssues.length ? (
                            <section className="toiv-edit-issues">
                                <h4>缺素材清单 <span className="meta">{missingIssues.length}</span></h4>
                                <ul>
                                    {missingIssues.map(issue => (
                                        <li key={issue.shotId}>
                                            <span>{issue.label}</span>
                                            <span className="meta">{issue.detail}</span>
                                            <Button size="sm" variant="ghost" onClick={() => openStoryboard(issue.shotId)}>去流水线补齐</Button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ) : null}
                        {durationIssues.length ? (
                            <section className="toiv-edit-issues">
                                <h4>时长异常清单 <span className="meta">{durationIssues.length}</span></h4>
                                <ul>
                                    {durationIssues.map(issue => (
                                        <li key={issue.shotId}>
                                            <span>{issue.label}</span>
                                            <span className="meta">{issue.detail}</span>
                                            <Button size="sm" variant="ghost" disabled={!v1Clips.some(clip => clip.shotId === issue.shotId)}
                                                onClick={() => locate(issue.shotId)}>在时间线定位</Button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ) : null}
                        <div className="toiv-edit-export-actions" role="group" aria-label="导出格式">
                            {model.finalUrl ? (
                                <a className="pf-btn pf-btn-outline pf-btn-sm" href={primeTakeMediaUrl(model.finalUrl)}
                                    download aria-label="导出成片">导出成片</a>
                            ) : (
                                <Button size="sm" variant="outline" disabled title="项目尚无成片，先合成">导出成片</Button>
                            )}
                            {(Object.keys(EXPORT_LABEL) as PrimeExportKind[]).map(kind => (
                                <Button key={kind} size="sm" variant="outline"
                                    aria-label={`导出${EXPORT_LABEL[kind]}`}
                                    disabled={Boolean(exportBlocked) || Boolean(exportBusy) || busy}
                                    title={exportBlocked || undefined}
                                    onClick={() => void runExport(kind)}>
                                    {exportBusy === kind ? "导出中…" : kind === "jianying" ? "剪映草稿 ZIP"
                                        : kind === "multitrack" ? "多轨 ZIP" : EXPORT_LABEL[kind]}
                                </Button>
                            ))}
                        </div>
                        {exportBlocked ? <p className="meta" role="note">{exportBlocked}</p> : null}
                    </section>
                ) : null}
                {model && model.shots.length === 0 ? (
                    <p className="toiv-empty">暂无分镜；剪辑湾只消费已归档片段。</p>
                ) : null}
                {model && model.shots.length > 0 ? (
                    <>
                        <div className="toiv-edit-layout">
                            <section className="toiv-edit-stage" aria-label="预览播放器">
                                <div className="toiv-edit-screen">
                                    {playerSrc ? (
                                        <video ref={videoRef} src={playerSrc} muted playsInline preload="metadata"
                                            aria-label={activeShot ? `${activeShot.label} 预览` : "时间线预览"}
                                            onLoadedMetadata={(event) => {
                                                const offset = timeRef.current - (activeClip?.startSec ?? 0);
                                                if (offset > 0.05) event.currentTarget.currentTime = offset;
                                            }} />
                                    ) : (
                                        <p className="placeholder">{hasClips ? "当前时间没有可预览片段" : "没有可预览的画面片段"}</p>
                                    )}
                                    <span className="toiv-edit-badge">{activeClip?.label ?? "无片段"}</span>
                                </div>
                                <div className="toiv-edit-transport" role="group" aria-label="播放控制">
                                    <Button size="sm" variant="outline" aria-label="上一镜" disabled={!hasClips} onClick={goPrev}>上一镜</Button>
                                    <Button size="sm" variant="lime" aria-label={playing ? "暂停" : "播放"}
                                        disabled={!totalSec} onClick={togglePlay}>{playing ? "暂停" : "播放"}</Button>
                                    <Button size="sm" variant="outline" aria-label="下一镜" disabled={!hasClips} onClick={goNext}>下一镜</Button>
                                    <Button size="sm" variant="ghost" aria-label="回到开头" disabled={!totalSec}
                                        onClick={() => seek(0, false)}>回到开头</Button>
                                    <span className="toiv-edit-clock" aria-label="播放时间">
                                        {formatPrimeTime(timeSec)} / {formatPrimeTime(totalSec)}
                                    </span>
                                </div>
                                <input className="toiv-edit-scrub" type="range" aria-label="播放头"
                                    min={0} max={Math.max(0.1, totalSec)} step={0.1}
                                    value={Math.min(timeSec, Math.max(0.1, totalSec))} disabled={!totalSec}
                                    onChange={(event: ChangeEvent<HTMLInputElement>) => seek(Number(event.target.value))} />
                                <p className="meta">空格 播放/暂停 · J/K/L 上一镜/播放/下一镜 · ←/→ 逐秒；吸附开启时靠近切点会贴合。</p>
                            </section>
                            <aside className="toiv-edit-inspector" aria-label="片段详情">
                                {selectedShot ? (
                                    <>
                                        <header>
                                            <b>{selectedShot.label}</b>
                                            <span className={`flag flag-${selectedShot.status}`}>{STATUS_LABEL[selectedShot.status]}</span>
                                            <span className="meta">{selectedShot.camera || "镜头未标注"} · {selectedShot.beats ? `${selectedShot.beats} 拍` : "单镜"}</span>
                                        </header>
                                        {selectedShot.error ? <p role="alert">{selectedShot.error}</p> : null}
                                        {!selectedClip ? <p className="toiv-edit-warn" role="status">该镜缺最终片段，未进时间线；补齐后可导出。</p> : null}
                                        {primeShotStale(selectedShot) ? <p className="toiv-edit-warn" role="status">最终片段已过期；重新渲染后再合成。</p> : null}
                                        <p className="toiv-dialogue">
                                            {selectedShot.dialogue.trim()
                                                ? <><span className="who">{selectedShot.speaker || "旁白"}</span>「{selectedShot.dialogue}」</>
                                                : <span className="meta">本镜无台词</span>}
                                        </p>
                                        <label className="toiv-prompt">声明时长（秒）
                                            <input type="number" min={selectedShot.minSec} max={selectedShot.maxSec} step={1}
                                                aria-label="选中镜时长（秒）" value={durationText} disabled={busy}
                                                onChange={(event: ChangeEvent<HTMLInputElement>) => setDurationText(event.target.value)}
                                                onBlur={commitDurationText}
                                                onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                                                    if (event.key === "Enter") { event.preventDefault(); commitDurationText(); }
                                                }} />
                                        </label>
                                        <p className="meta">范围 {selectedShot.minSec}–{selectedShot.maxSec} 秒；切点按声明时长，成片按实际素材长度合成。</p>
                                        <div className="toiv-edit-steps">
                                            <Button size="sm" variant="outline" aria-label="时长减 1 秒"
                                                disabled={busy || selectedDuration <= selectedShot.minSec}
                                                onClick={() => setDuration(selectedShot, selectedDuration - 1)}>−1s</Button>
                                            <Button size="sm" variant="outline" aria-label="时长加 1 秒"
                                                disabled={busy || selectedDuration >= selectedShot.maxSec}
                                                onClick={() => setDuration(selectedShot, selectedDuration + 1)}>+1s</Button>
                                            <Button size="sm" variant="ghost" aria-label="分割片段（不可用）" disabled
                                                title="分割不可用：源视频入点固定为 0，时间线不支持子片段">分割</Button>
                                        </div>
                                        {selectedDuration !== selectedShot.durationSec ? (
                                            <p className="meta">未保存：{selectedShot.durationSec}s → {selectedDuration}s</p>
                                        ) : null}
                                        <dl className="toiv-edit-meta">
                                            <dt>成片素材</dt><dd>{MEDIA_LABEL[selectedShot.media.final]}</dd>
                                            <dt>配音素材</dt><dd>{MEDIA_LABEL[selectedShot.media.audio]}</dd>
                                            <dt>入线</dt><dd>{selectedClip ? `${formatPrimeTime(selectedClip.startSec)} 起` : "未进时间线"}</dd>
                                        </dl>
                                        <div className="toiv-edit-inspector-actions">
                                            <Button size="sm" variant="outline" onClick={() => openStoryboard(selectedShot.id)}>在流水线打开</Button>
                                            <Button size="sm" variant="ghost" disabled={!selectedClip}
                                                onClick={() => locate(selectedShot.id)}>在时间线定位</Button>
                                        </div>
                                    </>
                                ) : <p className="meta">在时间线选择片段以编辑时长；未进线镜头也可从「未进时间线」中选中查看原因。</p>}
                            </aside>
                        </div>
                        <section className="toiv-edit-timeline" aria-label="四轨时间线">
                            <header className="toiv-edit-tlbar">
                                <b>四轨时间线</b>
                                <span className="meta">{dirtyCount ? `${dirtyCount} 镜未保存` : `${v1Clips.length} 画面片段 · ${formatPrimeTime(totalSec)}`}</span>
                                <div className="toiv-edit-tools">
                                    <Button size="sm" variant={snap ? "lime" : "ghost"} aria-pressed={snap}
                                        onClick={() => setSnap(value => !value)}>吸附切点</Button>
                                    <label>缩放
                                        <input className="toiv-edit-zoom" type="range" aria-label="时间线缩放"
                                            min={16} max={160} step={8} value={pxPerSec}
                                            onChange={(event: ChangeEvent<HTMLInputElement>) => setPxPerSec(Number(event.target.value))} />
                                    </label>
                                    <span className="toiv-edit-history">
                                        <Button size="sm" variant="ghost" aria-label="撤销" disabled={!past.length || busy} onClick={undo}>撤销</Button>
                                        <Button size="sm" variant="ghost" aria-label="重做" disabled={!future.length || busy} onClick={redo}>重做</Button>
                                    </span>
                                </div>
                            </header>
                            {missingIssues.length ? (
                                <div className="toiv-edit-missing" role="group" aria-label="未进时间线的镜头">
                                    <span className="meta">未进时间线：</span>
                                    {missingIssues.map(issue => (
                                        <Button key={issue.shotId} variant="ghost" size="sm" className="toiv-edit-miss-chip"
                                            aria-pressed={selectedId === issue.shotId}
                                            onClick={() => setSelectedId(issue.shotId)}>
                                            {issue.label} · 缺片段
                                        </Button>
                                    ))}
                                </div>
                            ) : null}
                            {!hasClips ? <p className="toiv-edit-warn" role="status">没有可导出的画面片段；先补齐最终片段。</p> : null}
                            <div className="toiv-edit-scroll">
                                <div className="toiv-edit-canvas">
                                    <div className="toiv-edit-ruler" style={{ width: contentWidth }}
                                        onClick={seekFromPointer} aria-hidden="true">
                                        {Array.from({ length: Math.floor(totalSec) + 1 }, (_, sec) => (
                                            <span key={sec} className={`tick${sec % 5 === 0 ? " major" : ""}`}
                                                style={{ left: sec * pxPerSec }} />
                                        ))}
                                        {v1Clips.map(clip => (
                                            <span key={`cut-${clip.id}`} className="cut" style={{ left: clip.startSec * pxPerSec }} />
                                        ))}
                                        <span className="marker" style={{ left: Math.min(timeSec * pxPerSec, contentWidth) }} />
                                    </div>
                                    {PRIME_EDIT_TRACKS.map(track => {
                                        const trackClips = clips.filter(clip => clip.track === track.key);
                                        return (
                                            <div className="toiv-edit-lane" key={track.key}>
                                                <span className="label" title={track.hint}>{track.label}</span>
                                                <div className="toiv-edit-track" style={{ width: contentWidth }}
                                                    onClick={(event) => seekFromPointer(event)}>
                                                    {trackClips.length === 0 ? <span className="empty">{track.hint}</span> : null}
                                                    {trackClips.map(clip => {
                                                        const selected = selectedId === clip.shotId;
                                                        return (
                                                            <Button key={clip.id} variant="ghost" size="sm"
                                                                className={`toiv-edit-clip tr-${clip.track}${selected ? " is-selected" : ""}`}
                                                                aria-pressed={selected}
                                                                aria-label={`${clip.label} · ${clip.durationSec.toFixed(1)}s${clip.track === "s1" ? " 字幕" : ""}`}
                                                                style={{ left: clip.startSec * pxPerSec, width: Math.max(16, clip.durationSec * pxPerSec) }}
                                                                onClick={(event) => { event.stopPropagation(); selectClip(clip); }}>
                                                                <span>{clip.track === "s1" ? clip.text || clip.label : clip.label}</span>
                                                                <i>{formatPrimeTime(clip.startSec)}</i>
                                                            </Button>
                                                        );
                                                    })}
                                                    {track.key === "v1" && selectedClip ? (
                                                        <span className={`toiv-edit-trim${dragging ? " is-dragging" : ""}`} role="separator"
                                                            tabIndex={0} aria-label={`拖动调整 ${selectedClip.label} 时长`}
                                                            aria-orientation="horizontal" aria-valuemin={selectedShot?.minSec}
                                                            aria-valuemax={selectedShot?.maxSec} aria-valuenow={selectedDuration}
                                                            style={{ left: (selectedClip.startSec + selectedClip.durationSec) * pxPerSec - 6 }}
                                                            onPointerDown={startTrim} onPointerMove={moveTrim}
                                                            onPointerUp={endTrim} onPointerCancel={endTrim}
                                                            onKeyDown={(event: ReactKeyboardEvent<HTMLSpanElement>) => {
                                                                if (!selectedShot) return;
                                                                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    setDuration(selectedShot, selectedDuration + (event.key === "ArrowRight" ? 1 : -1));
                                                                }
                                                            }} />
                                                    ) : null}
                                                    <span className="toiv-edit-playhead" style={{ left: timeSec * pxPerSec }} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </section>
                        {model.finalUrl ? (
                            <p className="toiv-final" role="group" aria-label="项目成片">
                                <span>成片已就绪</span>
                                <a className="toiv-final-link" href={primeTakeMediaUrl(model.finalUrl)} target="_blank" rel="noreferrer">查看成片</a>
                                <span className="meta">重新合成会覆盖当前成片</span>
                            </p>
                        ) : null}
                    </>
                ) : null}
            </section>
        </ToivShell>
    );
}
