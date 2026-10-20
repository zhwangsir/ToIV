import { ArrowLeft, Clapperboard, Loader2, Music, Plus, Trash2, Type, Upload, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { Button } from "antd";
import { ToolButton } from "@/components/ui/base/buttons";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { renderVideoEdit, type VideoEditAudio, type VideoEditClip, type VideoEditText, type VideoEditResult } from "@/services/toiv/client";
import { toivMediaUrl } from "@/services/toiv/agent-runs";

/**
 * 视频剪辑(F6 融合,自经典 VideoEditView 迁入):
 * 三轨剪辑(视频片段 in/duration/音量 · 音频轨 · 文字叠加)→ ffmpeg 渲染成片。
 * 表单式编辑(非拖拽时间线);渲染契约与经典一致(plan JSON + media[] 同发)。
 */

const MAX_MEDIA = 30;
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_CLIPS = 20;
const MAX_AUDIOS = 10;
const MAX_TEXTS = 20;
const MAX_TOTAL_SEC = 600;

const PRESETS = [
    { label: "1080p · 1920×1080 · 24fps", width: 1920, height: 1080, fps: 24 },
    { label: "720p · 1280×720 · 24fps", width: 1280, height: 720, fps: 24 },
    { label: "竖屏 1080×1920 · 24fps", width: 1080, height: 1920, fps: 24 },
];

type MediaKind = "video" | "audio";
type MediaItem = { id: string; file: File; kind: MediaKind; preview: string; duration: number | null; name: string };

const inputS = "w-20 rounded-md border bg-background px-2 py-1 text-sm tabular-nums";
const selS = "rounded-md border bg-background px-2 py-1 text-sm min-w-0";

function probeDuration(url: string, kind: MediaKind): Promise<number | null> {
    return new Promise((resolve) => {
        const el = document.createElement(kind === "video" ? "video" : "audio");
        el.preload = "metadata";
        el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : null);
        el.onerror = () => resolve(null);
        el.src = url;
    });
}

export default function VideoToolsPage() {
    const [media, setMedia] = useState<MediaItem[]>([]);
    const [clips, setClips] = useState<VideoEditClip[]>([]);
    const [audios, setAudios] = useState<VideoEditAudio[]>([]);
    const [texts, setTexts] = useState<VideoEditText[]>([]);
    const [presetIdx, setPresetIdx] = useState(0);
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<VideoEditResult | null>(null);
    const seq = useRef(0);

    useEffect(() => () => { for (const m of media) URL.revokeObjectURL(m.preview); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const addMedia = (files: FileList | null) => {
        if (!files) return;
        setError(null);
        for (const f of Array.from(files)) {
            if (media.length >= MAX_MEDIA) { setError(`媒体文件已达上限 ${MAX_MEDIA}`); break; }
            if (f.size > MAX_BYTES) { setError(`文件超过 500MB:${f.name}`); continue; }
            const isVideo = f.type.startsWith("video") || /\.(mp4|webm|mov|mkv)$/i.test(f.name);
            const kind: MediaKind = isVideo ? "video" : "audio";
            const item: MediaItem = {
                id: `${++seq.current}`, file: f, kind,
                preview: URL.createObjectURL(f), duration: null, name: f.name,
            };
            setMedia((prev) => [...prev, item]);
            void probeDuration(item.preview, kind).then((d) =>
                setMedia((prev) => prev.map((m) => (m.id === item.id ? { ...m, duration: d } : m))),
            );
        }
    };

    const totalSec = clips.reduce((s, c) => s + (c.duration || 0), 0);

    const render = async () => {
        if (busy) return;
        if (clips.length === 0) { setError("至少需要一个视频片段"); return; }
        if (totalSec > MAX_TOTAL_SEC) { setError(`总时长超过 ${MAX_TOTAL_SEC}s 上限(当前 ${Math.round(totalSec)}s)`); return; }
        const preset = PRESETS[presetIdx];
        // media 数组顺序即 plan.file 下标;未引用的媒体也会随请求上行(契约如此,后端只取 plan 引用)
        setBusy(true);
        setError(null);
        setResult(null);
        setPhase("渲染中(ffmpeg,分钟级)…");
        try {
            const res = await renderVideoEdit(
                { width: preset.width, height: preset.height, fps: preset.fps, clips, audios, texts },
                media.map((m) => m.file),
            );
            setResult(res);
        } catch (e) {
            setError(e instanceof Error ? e.message : "渲染失败");
        } finally {
            setBusy(false);
            setPhase("");
        }
    };

    return (
        <WorkspacePage fluid className="toiv-tools-page toiv-video-tools-page">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
                <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-xl font-semibold leading-7 text-foreground">视频剪辑</h1>
                        <p className="text-xs leading-5 text-muted-foreground">片段串接 / 音量 / 音频轨 / 文字叠加 → ffmpeg 成片;总时长上限 10 分钟</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link to="/toiv/market"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="工具箱" /></Link>
                        <Link to="/"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="返回首页" /></Link>
                    </div>
                </header>

                {/* 媒体池 */}
                <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">媒体池({media.length}/{MAX_MEDIA})</h2>
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-surface-hover">
                            <Upload className="size-4" /><span>添加视频/音频</span>
                            <input type="file" className="hidden" multiple accept="video/*,audio/*" disabled={busy}
                                onChange={(e) => { addMedia(e.target.files); e.currentTarget.value = ""; }} />
                        </label>
                    </div>
                    {media.length > 0 && (
                        <ul className="flex flex-wrap gap-2">
                            {media.map((m, i) => (
                                <li key={m.id} className="flex max-w-56 items-center gap-2 rounded-lg border px-2 py-1 text-xs">
                                    {m.kind === "video" ? <Video className="size-3.5 shrink-0" /> : <Music className="size-3.5 shrink-0" />}
                                    <span className="min-w-0 flex-1 truncate" title={m.name}>{i}. {m.name}</span>
                                    <span className="shrink-0 tabular-nums text-muted-foreground">{m.duration ? `${m.duration.toFixed(1)}s` : "…"}</span>
                                    {!busy && (
                                        <button type="button" className="shrink-0 text-muted-foreground hover:text-destructive" title="移除"
                                            onClick={() => { URL.revokeObjectURL(m.preview); setMedia((prev) => prev.filter((x) => x.id !== m.id)); }}>
                                            <Trash2 className="size-3.5" />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                    {/* 视频轨 */}
                    <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-sm font-semibold">视频轨({clips.length}/{MAX_CLIPS})</h2>
                            <ToolButton variant="ghost" size="sm" icon={<Plus className="size-3.5" />} label="加片段"
                                disabled={busy || media.length === 0 || clips.length >= MAX_CLIPS || !media.some((m) => m.kind === "video")}
                                onClick={() => setClips((prev) => [...prev, { file: media.findIndex((m) => m.kind === "video"), in: 0, duration: 3, volume: 1 }])} />
                        </div>
                        {clips.map((c, i) => (
                            <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border p-2 text-xs">
                                <select className={selS} value={c.file} onChange={(e) => setClips((p) => p.map((x, j) => (j === i ? { ...x, file: Number(e.target.value) } : x)))}>
                                    {media.map((m, mi) => <option key={m.id} value={mi}>{mi}. {m.name.slice(0, 18)}</option>)}
                                </select>
                                <label className="flex items-center gap-1">入点<input className={inputS} type="number" min={0} step={0.1} value={c.in} onChange={(e) => setClips((p) => p.map((x, j) => (j === i ? { ...x, in: Number(e.target.value) } : x)))} />s</label>
                                <label className="flex items-center gap-1">时长<input className={inputS} type="number" min={0.1} step={0.1} value={c.duration} onChange={(e) => setClips((p) => p.map((x, j) => (j === i ? { ...x, duration: Number(e.target.value) } : x)))} />s</label>
                                <label className="flex items-center gap-1">音量<input className={`${inputS} w-16`} type="number" min={0} max={1} step={0.1} value={c.volume} onChange={(e) => setClips((p) => p.map((x, j) => (j === i ? { ...x, volume: Number(e.target.value) } : x)))} /></label>
                                <div className="ml-auto flex gap-1">
                                    <button type="button" disabled={i === 0 || busy} className="rounded p-1 hover:bg-surface-hover disabled:opacity-30" title="上移"
                                        onClick={() => setClips((p) => { const n = [...p]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}>↑</button>
                                    <button type="button" disabled={i === clips.length - 1 || busy} className="rounded p-1 hover:bg-surface-hover disabled:opacity-30" title="下移"
                                        onClick={() => setClips((p) => { const n = [...p]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })}>↓</button>
                                    <button type="button" disabled={busy} className="rounded p-1 text-muted-foreground hover:text-destructive" title="移除"
                                        onClick={() => setClips((p) => p.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></button>
                                </div>
                            </div>
                        ))}
                        <p className="text-xs text-muted-foreground">总时长 {totalSec.toFixed(1)}s</p>
                    </section>

                    {/* 音频轨 */}
                    <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-sm font-semibold">音频轨({audios.length}/{MAX_AUDIOS})</h2>
                            <ToolButton variant="ghost" size="sm" icon={<Plus className="size-3.5" />} label="加音频"
                                disabled={busy || media.length === 0 || audios.length >= MAX_AUDIOS}
                                onClick={() => setAudios((prev) => [...prev, { file: media.findIndex((m) => m.kind === "audio") >= 0 ? media.findIndex((m) => m.kind === "audio") : 0, in: 0, duration: 5, start: 0, volume: 1 }])} />
                        </div>
                        {audios.map((a, i) => (
                            <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border p-2 text-xs">
                                <select className={selS} value={a.file} onChange={(e) => setAudios((p) => p.map((x, j) => (j === i ? { ...x, file: Number(e.target.value) } : x)))}>
                                    {media.map((m, mi) => <option key={m.id} value={mi}>{mi}. {m.name.slice(0, 18)}</option>)}
                                </select>
                                <label className="flex items-center gap-1">起点<input className={inputS} type="number" min={0} step={0.1} value={a.start} onChange={(e) => setAudios((p) => p.map((x, j) => (j === i ? { ...x, start: Number(e.target.value) } : x)))} />s</label>
                                <label className="flex items-center gap-1">时长<input className={inputS} type="number" min={0.1} step={0.1} value={a.duration} onChange={(e) => setAudios((p) => p.map((x, j) => (j === i ? { ...x, duration: Number(e.target.value) } : x)))} />s</label>
                                <label className="flex items-center gap-1">入点<input className={`${inputS} w-14`} type="number" min={0} step={0.1} value={a.in} onChange={(e) => setAudios((p) => p.map((x, j) => (j === i ? { ...x, in: Number(e.target.value) } : x)))} /></label>
                                <label className="flex items-center gap-1">音量<input className={`${inputS} w-14`} type="number" min={0} max={2} step={0.1} value={a.volume} onChange={(e) => setAudios((p) => p.map((x, j) => (j === i ? { ...x, volume: Number(e.target.value) } : x)))} /></label>
                                <button type="button" disabled={busy} className="ml-auto rounded p-1 text-muted-foreground hover:text-destructive" title="移除"
                                    onClick={() => setAudios((p) => p.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></button>
                            </div>
                        ))}
                        <p className="text-xs text-muted-foreground">BGM / 旁白混音,起点为时间线位置</p>
                    </section>

                    {/* 文字轨 */}
                    <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-sm font-semibold">文字叠加({texts.length}/{MAX_TEXTS})</h2>
                            <ToolButton variant="ghost" size="sm" icon={<Plus className="size-3.5" />} label="加文字"
                                disabled={busy || texts.length >= MAX_TEXTS}
                                onClick={() => setTexts((prev) => [...prev, { text: "标题文字", start: 0, end: 3, position: "bottom", fontSize: 36, color: "#ffffff" }])} />
                        </div>
                        {texts.map((t, i) => (
                            <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-2 text-xs">
                                <div className="flex items-center gap-1.5">
                                    <Type className="size-3.5 shrink-0" />
                                    <input className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1" value={t.text} maxLength={120}
                                        onChange={(e) => setTexts((p) => p.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                                    <button type="button" disabled={busy} className="rounded p-1 text-muted-foreground hover:text-destructive"
                                        onClick={() => setTexts((p) => p.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></button>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <label className="flex items-center gap-1">起<input className={`${inputS} w-14`} type="number" min={0} step={0.1} value={t.start} onChange={(e) => setTexts((p) => p.map((x, j) => (j === i ? { ...x, start: Number(e.target.value) } : x)))} />s</label>
                                    <label className="flex items-center gap-1">止<input className={`${inputS} w-14`} type="number" min={0} step={0.1} value={t.end} onChange={(e) => setTexts((p) => p.map((x, j) => (j === i ? { ...x, end: Number(e.target.value) } : x)))} />s</label>
                                    <select className={selS} value={t.position} onChange={(e) => setTexts((p) => p.map((x, j) => (j === i ? { ...x, position: e.target.value } : x)))}>
                                        <option value="top">顶部</option><option value="center">居中</option><option value="bottom">底部</option>
                                    </select>
                                    <input className={`${inputS} w-14`} type="number" min={12} max={200} value={t.fontSize} title="字号"
                                        onChange={(e) => setTexts((p) => p.map((x, j) => (j === i ? { ...x, fontSize: Number(e.target.value) } : x)))} />
                                    <input className="size-6 rounded border bg-background" type="color" value={t.color} title="颜色"
                                        onChange={(e) => setTexts((p) => p.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} />
                                </div>
                            </div>
                        ))}
                    </section>
                </div>

                {/* 规格与渲染 */}
                <section className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-4">
                    <span className="text-sm text-muted-foreground">输出规格</span>
                    <select className={selS} value={presetIdx} disabled={busy} onChange={(e) => setPresetIdx(Number(e.target.value))}>
                        {PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
                    </select>
                    <span className="flex-1" />
                    {error && <Callout tone="error" title={error} onClose={() => setError(null)} />}
                    {phase && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{phase}</p>}
                    <Button type="primary" size="small" icon={<Clapperboard className="size-3.5" />} loading={busy} disabled={clips.length === 0} onClick={() => void render()}>
                        渲染成片
                    </Button>
                </section>

                {result && (
                    <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                        <h2 className="text-sm font-semibold">成片</h2>
                        <video src={toivMediaUrl(result.url)} controls playsInline className="max-h-[420px] w-full rounded-lg bg-black/5" />
                        <p className="text-xs text-muted-foreground">
                            {result.clips} 片段 · {result.audios} 音频 · {result.texts} 文字 · {Math.round(result.duration)}s · {result.width}×{result.height}@{result.fps}
                            <a className="ml-2 underline" href={toivMediaUrl(result.url)} download>下载</a>
                        </p>
                    </section>
                )}
                {!result && !phase && <EmptyState description="添加媒体 → 编排三轨 → 渲染成片" />}
            </div>
        </WorkspacePage>
    );
}
