/**
 * Creation-studio preview timeline (R8).
 * Tracks / playhead / clips / zoom + transport — Freezone dark.
 * Mounted inside /create center stage (no second shell).
 * License: sizes from Toonflow-app + LumenX (MIT/A, rewrite); BeefTV mode only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ChevronDown,
    ChevronUp,
    Clapperboard,
    Maximize2,
    Pause,
    Play,
    SkipBack,
    SkipForward,
    StepBack,
    StepForward,
} from "lucide-react";

import { NsfwLockBadge } from "@/components/toiv/nsfw-lock-badge";
import { ToivEmptyState } from "@/components/toiv/toiv-empty-state";
import { cn } from "@/lib/utils";
import {
    COPY_MODE_ADULT,
    COPY_MODE_NORMAL,
    getAccountContentMode,
    subscribeR18Mode,
} from "@/redline";
import {
    fetchTimelinePreview,
    type TimelinePreviewItem,
    type TimelinePreviewResponse,
} from "@/services/toiv/timeline-preview";

import "@/components/create/creation-studio-preview-timeline.css";

type Props = {
    projectId?: string | null;
    className?: string;
};

function formatClock(sec: number, fps: number): string {
    const s = Math.max(0, sec);
    const totalFrames = Math.round(s * fps);
    const ff = totalFrames % Math.max(1, Math.round(fps));
    const totalSec = Math.floor(totalFrames / Math.max(1, Math.round(fps)));
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

function formatTick(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function readCssNumber(name: string, fallback: number, el?: Element | null): number {
    if (typeof window === "undefined") return fallback;
    const raw = getComputedStyle(el ?? document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

type LaidClip = TimelinePreviewItem & { startSec: number; endSec: number };

function layoutClips(items: TimelinePreviewItem[]): { video: LaidClip[]; audio: LaidClip[]; durationSec: number } {
    let vCursor = 0;
    let aCursor = 0;
    const video: LaidClip[] = [];
    const audio: LaidClip[] = [];
    for (const item of items) {
        const dur = Math.max(0.1, Number(item.duration_sec) || 0.1);
        if (item.kind === "audio") {
            const startSec = aCursor;
            const endSec = startSec + dur;
            audio.push({ ...item, startSec, endSec });
            aCursor = endSec;
        } else {
            const startSec = vCursor;
            const endSec = startSec + dur;
            video.push({ ...item, startSec, endSec });
            vCursor = endSec;
        }
    }
    return { video, audio, durationSec: Math.max(vCursor, aCursor, 1) };
}

export function CreationStudioPreviewTimeline({ projectId = null, className }: Props) {
    const [collapsed, setCollapsed] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [playhead, setPlayhead] = useState(0);
    const [zoom, setZoom] = useState(1); // product nail: zoom × --toiv-timeline-zoom-base-pps
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [payload, setPayload] = useState<TimelinePreviewResponse | null>(null);
    const [contentMode, setContentMode] = useState(getAccountContentMode);
    const scrollRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef<number | null>(null);
    const lastTsRef = useRef<number | null>(null);
    const rootRef = useRef<HTMLElement>(null);

    useEffect(() => subscribeR18Mode(() => setContentMode(getAccountContentMode())), []);

    useEffect(() => {
        const ac = new AbortController();
        void fetchTimelinePreview(projectId || "", {
            signal: ac.signal,
            // Live when pid present (backend 45ebdab4); mock only if unreachable / no pid.
            useMock: false,
            contentMode,
        })
            .then((data) => {
                if (!ac.signal.aborted) setPayload(data);
            })
            .catch(() => {
                if (!ac.signal.aborted) setPayload(null);
            });
        return () => ac.abort();
    }, [projectId, contentMode]);

    const fps = payload?.fps || 24;
    const items = payload?.items || [];
    const laid = useMemo(() => layoutClips(items), [items]);
    const durationSec = laid.durationSec;
    const zoomBasePps = readCssNumber("--toiv-timeline-zoom-base-pps", 96, rootRef.current);
    const zoomMin = readCssNumber("--toiv-timeline-zoom-min", 0.25, rootRef.current);
    const zoomMax = readCssNumber("--toiv-timeline-zoom-max", 4, rootRef.current);
    const zoomStep = readCssNumber("--toiv-timeline-zoom-step", 1.25, rootRef.current);
    const pxPerSec = zoomBasePps * zoom;
    const canvasWidth = Math.max(320, durationSec * pxPerSec + 48);

    const ticks = useMemo(() => {
        // Keep major ticks ≥ --toiv-timeline-ruler-min-tick-px (64) at current pps.
        const minPx = 64;
        const candidates = [1, 2, 5, 10, 15, 30, 60];
        const step = candidates.find((c) => c * pxPerSec >= minPx) || 60;
        const out: number[] = [];
        for (let t = 0; t <= durationSec + 0.001; t += step) out.push(Number(t.toFixed(3)));
        return out;
    }, [durationSec, pxPerSec]);

    const seekFromClientX = useCallback(
        (clientX: number) => {
            const el = canvasRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const x = clientX - rect.left + (scrollRef.current?.scrollLeft || 0);
            const next = Math.min(durationSec, Math.max(0, x / pxPerSec));
            setPlayhead(next);
        },
        [durationSec, pxPerSec],
    );

    useEffect(() => {
        if (!playing) {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            lastTsRef.current = null;
            return;
        }
        const tick = (ts: number) => {
            if (lastTsRef.current == null) lastTsRef.current = ts;
            const dt = (ts - lastTsRef.current) / 1000;
            lastTsRef.current = ts;
            setPlayhead((prev) => {
                const next = prev + dt;
                if (next >= durationSec) {
                    setPlaying(false);
                    return durationSec;
                }
                return next;
            });
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
    }, [playing, durationSec]);

    const stepFrame = (dir: -1 | 1) => {
        setPlaying(false);
        setPlayhead((p) => Math.min(durationSec, Math.max(0, p + dir / fps)));
    };

    const toggleFullscreen = async () => {
        const node = rootRef.current;
        if (!node) return;
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await node.requestFullscreen();
        } catch {
            /* ignore */
        }
    };

    const progressPct = durationSec > 0 ? Math.min(100, (playhead / durationSec) * 100) : 0;

    return (
        <section
            ref={rootRef}
            className={cn("toiv-timeline-dock", collapsed && "is-collapsed", className)}
            data-testid="creation-studio-preview-timeline"
            aria-label="预览时间线"
        >
            <div className="toiv-timeline-toolbar">
                <div className="toiv-timeline-transport">
                    <button type="button" className="toiv-timeline-btn" aria-label="跳到开头" onClick={() => { setPlaying(false); setPlayhead(0); }}>
                        <SkipBack aria-hidden />
                    </button>
                    <button type="button" className="toiv-timeline-btn is-frame" aria-label="上一帧" onClick={() => stepFrame(-1)}>
                        <StepBack aria-hidden />
                    </button>
                    <button
                        type="button"
                        className="toiv-timeline-btn is-primary"
                        aria-label={playing ? "暂停" : "播放"}
                        onClick={() => setPlaying((v) => !v)}
                    >
                        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
                    </button>
                    <button type="button" className="toiv-timeline-btn is-frame" aria-label="下一帧" onClick={() => stepFrame(1)}>
                        <StepForward aria-hidden />
                    </button>
                    <button type="button" className="toiv-timeline-btn" aria-label="跳到结尾" onClick={() => { setPlaying(false); setPlayhead(durationSec); }}>
                        <SkipForward aria-hidden />
                    </button>
                </div>
                <div className="toiv-timeline-timecode" aria-live="off">
                    <span>{formatClock(playhead, fps)}</span>
                    <span className="toiv-timeline-timecode-sep">/</span>
                    <span>{formatClock(durationSec, fps)}</span>
                </div>
                <div className="toiv-timeline-meta">
                    <span>{contentMode === "adult" ? COPY_MODE_ADULT : COPY_MODE_NORMAL}</span>
                    <span>{Math.round(fps)} fps</span>
                    <div className="inline-flex items-center gap-1" role="group" aria-label="时间线缩放">
                        <button
                            type="button"
                            className="toiv-timeline-btn is-frame"
                            aria-label="缩小"
                            onClick={() => setZoom((z) => Math.max(zoomMin, Number((z / zoomStep).toFixed(3))))}
                        >
                            −
                        </button>
                        <input
                            className="toiv-timeline-zoom"
                            type="range"
                            min={zoomMin}
                            max={zoomMax}
                            step={Math.min(0.25, zoomStep / 5)}
                            value={zoom}
                            aria-label="时间线缩放滑杆"
                            onChange={(e) => setZoom(Number(e.target.value))}
                        />
                        <button
                            type="button"
                            className="toiv-timeline-btn is-frame"
                            aria-label="放大"
                            onClick={() => setZoom((z) => Math.min(zoomMax, Number((z * zoomStep).toFixed(3))))}
                        >
                            +
                        </button>
                        <span>{Math.round(zoom * 100)}%</span>
                    </div>
                    <button type="button" className="toiv-timeline-btn" aria-label="全屏" title="全屏" onClick={() => void toggleFullscreen()}>
                        <Maximize2 aria-hidden />
                    </button>
                    <button
                        type="button"
                        className="toiv-timeline-btn"
                        aria-label={collapsed ? "展开时间线" : "收起时间线"}
                        onClick={() => setCollapsed((v) => !v)}
                    >
                        {collapsed ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
                    </button>
                </div>
            </div>

            <div className="toiv-timeline-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressPct)} aria-label="播放进度">
                <span style={{ width: `${progressPct}%` }} />
            </div>

            <div className="toiv-timeline-body">
                <div className="toiv-timeline-labels" aria-hidden>
                    <div className="toiv-timeline-label-ruler" />
                    <div className="toiv-timeline-label-row" data-kind="video">视频</div>
                    <div className="toiv-timeline-label-row" data-kind="audio">音频</div>
                </div>
                <div className="toiv-timeline-scroll" ref={scrollRef}>
                    {!items.length ? (
                        <ToivEmptyState
                            compact
                            className="toiv-timeline-empty"
                            icon={Clapperboard}
                            title="暂无预览片段"
                            description="解析分镜或生成镜头后，将按时间排列在此。"
                        />
                    ) : (
                        <div
                            className="toiv-timeline-canvas"
                            ref={canvasRef}
                            style={{ width: canvasWidth }}
                            onPointerDown={(e) => {
                                if ((e.target as HTMLElement).closest(".toiv-timeline-clip")) return;
                                seekFromClientX(e.clientX);
                            }}
                        >
                            <div className="toiv-timeline-ruler">
                                {ticks.map((t) => (
                                    <span key={t} className="toiv-timeline-tick" style={{ left: t * pxPerSec }}>
                                        {formatTick(t)}
                                    </span>
                                ))}
                            </div>
                            <div className="toiv-timeline-track" data-kind="video" role="list" aria-label="视频轨道">
                                {laid.video.map((clip) => {
                                    const locked = Boolean(clip.nsfw) && contentMode !== "adult";
                                    return (
                                        <button
                                            key={clip.shot_id}
                                            type="button"
                                            role="listitem"
                                            className={cn(
                                                "toiv-timeline-clip",
                                                selectedId === clip.shot_id && "is-selected",
                                                locked && "is-nsfw-locked",
                                            )}
                                            data-kind={clip.kind}
                                            style={{
                                                left: clip.startSec * pxPerSec,
                                                width: Math.max(24, (clip.endSec - clip.startSec) * pxPerSec),
                                            }}
                                            title={clip.shot_id}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setSelectedId(clip.shot_id);
                                                setPlayhead(clip.startSec);
                                            }}
                                        >
                                            {clip.preview_url ? (
                                                <img className="toiv-timeline-clip-thumb" src={clip.preview_url} alt="" draggable={false} />
                                            ) : null}
                                            <span className="truncate">{`镜头 ${clip.idx + 1}`}</span>
                                            {locked ? <NsfwLockBadge compact /> : null}
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="toiv-timeline-track" data-kind="audio" role="list" aria-label="音频轨道">
                                {laid.audio.map((clip) => (
                                    <button
                                        key={clip.shot_id}
                                        type="button"
                                        role="listitem"
                                        className={cn("toiv-timeline-clip", selectedId === clip.shot_id && "is-selected")}
                                        data-kind="audio"
                                        style={{
                                            left: clip.startSec * pxPerSec,
                                            width: Math.max(24, (clip.endSec - clip.startSec) * pxPerSec),
                                        }}
                                        title={clip.shot_id}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedId(clip.shot_id);
                                            setPlayhead(clip.startSec);
                                        }}
                                    >
                                        <span className="truncate">{`音频 ${clip.idx + 1}`}</span>
                                    </button>
                                ))}
                            </div>
                            <div className="toiv-timeline-playhead" style={{ left: playhead * pxPerSec }} />
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}
