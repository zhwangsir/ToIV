import { ArrowLeft, FileText, Languages, Loader2, Mic, Upload, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { Button } from "antd";
import { ToolButton } from "@/components/ui/base/buttons";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import {
    autocutDub,
    getAnimeLipsyncStatus,
    highlightsDub,
    importSrtDub,
    pollDubTranscribe,
    pollLipsyncLong,
    pollVoiceTrack,
    startAnimeLipsync,
    startDubTranscribe,
    startLipsyncLong,
    startVoiceTrack,
    translateDub,
    uploadDubMedia,
    type DubSegment,
} from "@/services/toiv/client";
import { toivMediaUrl } from "@/services/toiv/agent-runs";

/**
 * 视频译制(F7 融合,自经典 DubView 五步链迁入):
 * 上传视频 → 听写(whisper)/导入 SRT → LLM 翻译 → 克隆音色配音轨 → 对口型成片。
 * 每步产物独立可下载;配音轨用源视频音色克隆(ref_seconds 取样)。
 */

const LANGS = [
    { value: "en", label: "English" },
    { value: "ja", label: "日本語" },
    { value: "ko", label: "한국어" },
    { value: "zh", label: "中文" },
];

function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type Phase =
    | { kind: "idle" }
    | { kind: "upload"; pct: number }
    | { kind: "transcribe"; stage: string; pct: number }
    | { kind: "translate" }
    | { kind: "voice"; stage: string; pct: number }
    | { kind: "lipsync"; stage: string; done: number; total: number }
    | { kind: "anime"; stage: string; pct: number };

export default function DubToolsPage() {
    const [videoName, setVideoName] = useState("");
    const [videoLabel, setVideoLabel] = useState("");
    const [segments, setSegments] = useState<DubSegment[]>([]);
    const [translated, setTranslated] = useState<Record<number, string>>({});
    const [targetLang, setTargetLang] = useState("en");
    const [emoText, setEmoText] = useState("");
    const [voice, setVoice] = useState<{ url: string; duration: number; segment_count: number } | null>(null);
    const [lipsyncUrl, setLipsyncUrl] = useState("");
    const [highlights, setHighlights] = useState<{ title: string; selected: number[] } | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const [error, setError] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

    const guard = () => {
        if (pollRef.current) clearInterval(pollRef.current);
    };

    const upload = async (f: File) => {
        guard();
        setError(null);
        setSegments([]);
        setTranslated({});
        setVoice(null);
        setLipsyncUrl("");
        setPhase({ kind: "upload", pct: 0 });
        try {
            const up = await uploadDubMedia(f, (p) => setPhase({ kind: "upload", pct: p }));
            setVideoName(up.name);
            setVideoLabel(`${f.name}(${(f.size / 1024 / 1024).toFixed(1)}MB)`);
        } catch (e) {
            setError(e instanceof Error ? e.message : "上传失败");
        } finally {
            setPhase({ kind: "idle" });
        }
    };

    const transcribe = async () => {
        if (!videoName) return;
        guard();
        setError(null);
        setPhase({ kind: "transcribe", stage: "启动听写", pct: 0 });
        try {
            const { job_id } = await startDubTranscribe(videoName);
            await new Promise<void>((resolve, reject) => {
                pollRef.current = setInterval(async () => {
                    try {
                        const st = await pollDubTranscribe(job_id);
                        if (st.status === "done") {
                            guard();
                            setSegments(st.segments ?? []);
                            setPhase({ kind: "idle" });
                            resolve();
                        } else if (st.status === "error" || st.status === "canceled") {
                            guard();
                            reject(new Error(st.error || "听写失败"));
                        } else {
                            setPhase({ kind: "transcribe", stage: st.stage || "听写中", pct: st.progress ?? 0 });
                        }
                    } catch (e) {
                        guard();
                        reject(e);
                    }
                }, 2000);
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "听写失败");
            setPhase({ kind: "idle" });
        }
    };

    const importSrt = async (f: File) => {
        guard();
        setError(null);
        try {
            const r = await importSrtDub(f);
            setSegments(r.segments ?? []);
            setTranslated({});
        } catch (e) {
            setError(e instanceof Error ? e.message : "字幕导入失败");
        }
    };

    const translate = async () => {
        if (segments.length === 0) return;
        guard();
        setError(null);
        setPhase({ kind: "translate" });
        try {
            const r = await translateDub(segments.map((s) => ({ index: s.index, text: s.text })), targetLang);
            const map: Record<number, string> = {};
            for (const t of r.translated ?? []) map[t.index] = t.translated;
            setTranslated(map);
        } catch (e) {
            setError(e instanceof Error ? e.message : "翻译失败");
        } finally {
            setPhase({ kind: "idle" });
        }
    };

    const doVoice = async () => {
        if (!videoName || segments.length === 0) return;
        guard();
        setError(null);
        setVoice(null);
        setPhase({ kind: "voice", stage: "启动配音", pct: 0 });
        try {
            const segs = segments.map((s) => ({ start: s.start, end: s.end, text: translated[s.index] ?? s.text }));
            const { job_id } = await startVoiceTrack({ name: videoName, segments: segs, ...(emoText.trim() ? { emoText: emoText.trim() } : {}) });
            await new Promise<void>((resolve, reject) => {
                pollRef.current = setInterval(async () => {
                    try {
                        const st = await pollVoiceTrack(job_id);
                        if (st.status === "done") {
                            guard();
                            setVoice({ url: st.url ?? "", duration: st.duration ?? 0, segment_count: st.segment_count ?? segs.length });
                            setPhase({ kind: "idle" });
                            resolve();
                        } else if (st.status === "error" || st.status === "canceled") {
                            guard();
                            reject(new Error(st.error || "配音失败"));
                        } else {
                            setPhase({ kind: "voice", stage: st.stage || "合成中", pct: st.progress ?? 0 });
                        }
                    } catch (e) {
                        guard();
                        reject(e);
                    }
                }, 2000);
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "配音失败");
            setPhase({ kind: "idle" });
        }
    };

    const doLipsync = async () => {
        if (!videoName) return;
        guard();
        setError(null);
        setLipsyncUrl("");
        setPhase({ kind: "lipsync", stage: "启动对口型", done: 0, total: 0 });
        try {
            const { job_id } = await startLipsyncLong({
                name: videoName,
                ...(voice ? { audioName: voice.url.split("/").pop()?.split("?")[0] } : {}),
            });
            await new Promise<void>((resolve, reject) => {
                pollRef.current = setInterval(async () => {
                    try {
                        const st = await pollLipsyncLong(job_id);
                        if (st.status === "done") {
                            guard();
                            setLipsyncUrl(st.url ?? "");
                            setPhase({ kind: "idle" });
                            resolve();
                        } else if (st.status === "error") {
                            guard();
                            reject(new Error(st.error || "对口型失败"));
                        } else {
                            setPhase({ kind: "lipsync", stage: st.stage || "处理中", done: st.completed ?? 0, total: st.total ?? 0 });
                        }
                    } catch (e) {
                        guard();
                        reject(e);
                    }
                }, 3000);
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "对口型失败");
            setPhase({ kind: "idle" });
        }
    };

    // V4-5:AI 精剪——LLM 从字幕挑高光句,选中的分段高亮
    const pickHighlights = async () => {
        if (segments.length === 0) return;
        guard();
        setError(null);
        setPhase({ kind: "translate" });
        try {
            const r = await highlightsDub(segments.map((s) => ({ index: s.index, text: s.text })), 0);
            setHighlights({ title: r.title, selected: r.selected ?? [] });
        } catch (e) {
            setError(e instanceof Error ? e.message : "AI 精剪失败");
        } finally {
            setPhase({ kind: "idle" });
        }
    };

    // V4-5:自动切段(场景/静音检测)——切段结果直接填给对口型
    const [autocutMode, setAutocutMode] = useState<"scene" | "silence">("scene");
    const runAutocut = async () => {
        if (!videoName) return;
        guard();
        setError(null);
        setPhase({ kind: "translate" });
        try {
            const r = await autocutDub(videoName, autocutMode, 0.4, 3);
            const segs: DubSegment[] = (r.segments ?? []).map((x, i) => ({
                index: i, start: x.start, end: x.end,
                text: segments.find((o) => o.start >= x.start && o.end <= x.end)?.text ?? "",
            }));
            setSegments(segs);
        } catch (e) {
            setError(e instanceof Error ? e.message : "自动切段失败");
        } finally {
            setPhase({ kind: "idle" });
        }
    };

    // V4-5:动漫口型(本地 CV,非 LatentSync;低配替代)
    const doAnimeLipsync = async () => {
        if (!videoName) return;
        guard();
        setError(null);
        setLipsyncUrl("");
        setPhase({ kind: "anime", stage: "启动动漫口型", pct: 0 });
        try {
            const { job_id } = await startAnimeLipsync(
                videoName,
                voice?.url.split("/").pop()?.split("?")[0],
            );
            await new Promise<void>((resolve, reject) => {
                pollRef.current = setInterval(async () => {
                    try {
                        const st = await getAnimeLipsyncStatus(job_id);
                        if (st.status === "done") {
                            guard();
                            setLipsyncUrl(st.url ?? "");
                            setPhase({ kind: "idle" });
                            resolve();
                        } else if (st.status === "error") {
                            guard();
                            reject(new Error(st.error || "动漫口型失败"));
                        } else {
                            setPhase({ kind: "anime", stage: st.stage || "处理中", pct: st.progress ?? 0 });
                        }
                    } catch (e) {
                        guard();
                        reject(e);
                    }
                }, 2000);
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "动漫口型失败");
            setPhase({ kind: "idle" });
        }
    };

    const busy = phase.kind !== "idle";

    const phaseText = (): string => {
        switch (phase.kind) {
            case "upload": return `上传中 ${phase.pct}%`;
            case "transcribe": return `${phase.stage} ${phase.pct}%`;
            case "translate": return "LLM 翻译中(段数多耗时长)…";
            case "voice": return `${phase.stage} ${phase.pct}%`;
            case "lipsync": return `${phase.stage}${phase.total ? ` ${phase.done}/${phase.total}` : ""}`;
            case "anime": return `${phase.stage} ${phase.pct}%`;
            default: return "";
        }
    };

    return (
        <WorkspacePage fluid className="toiv-dub-page">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
                <header className="flex items-center justify-between">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-xl font-semibold leading-7 text-foreground">视频译制</h1>
                        <p className="text-xs leading-5 text-muted-foreground">上传 → 听写/导入字幕 → 翻译 → 克隆音色配音 → 对口型成片</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link to="/toiv/market"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="工具箱" /></Link>
                        <Link to="/"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="返回首页" /></Link>
                    </div>
                </header>

                {error && <Callout tone="error" title={error} onClose={() => setError(null)} />}
                {busy && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{phaseText()}</p>}

                {/* Step 1 上传 */}
                <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                    <h2 className="flex items-center gap-2 text-sm font-semibold"><Video className="size-4" />① 源视频</h2>
                    <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 text-sm text-muted-foreground transition-colors hover:border-[var(--workspace-accent,#666)]"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void upload(f); }}>
                        <Upload className="size-6" />
                        <span>{videoLabel || "点击或拖入视频文件(长视频流式上传)"}</span>
                        <input type="file" className="hidden" accept="video/*" disabled={busy}
                            onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void upload(f); }} />
                    </label>
                </section>

                {/* Step 2 听写/SRT */}
                <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="flex items-center gap-2 text-sm font-semibold"><FileText className="size-4" />② 字幕(听写或导入)</h2>
                        <span className="flex-1" />
                        <Button size="small" icon={<FileText className="size-3.5" />} disabled={!videoName || busy} loading={phase.kind === "transcribe"} onClick={() => void transcribe()}>
                            Whisper 听写
                        </Button>
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-surface-hover">
                            <Upload className="size-3.5" /><span>导入 SRT/VTT</span>
                            <input type="file" className="hidden" accept=".srt,.vtt" disabled={busy}
                                onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void importSrt(f); }} />
                        </label>
                    </div>
                    {segments.length > 0 && (
                        <ol className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-xl border p-2 text-sm">
                            {segments.map((s) => (
                                <li key={s.index} className={`flex flex-col gap-0.5 rounded-md px-1 ${highlights?.selected.includes(s.index) ? "bg-warning/15 ring-1 ring-warning/40" : ""}`}>
                                    <div className="flex gap-2 text-xs text-muted-foreground">
                                        <span className="shrink-0 tabular-nums">{fmtTime(s.start)}→{fmtTime(s.end)}</span>
                                        {highlights?.selected.includes(s.index) && <span className="text-warning">★ 高光</span>}
                                    </div>
                                    <p className="break-words">{s.text}</p>
                                    {translated[s.index] && <p className="break-words text-primary/90">{translated[s.index]}</p>}
                                </li>
                            ))}
                        </ol>
                    )}
                </section>

                {/* Step 3 翻译 */}
                <section className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card p-4">
                    <h2 className="flex items-center gap-2 text-sm font-semibold"><Languages className="size-4" />③ 翻译</h2>
                    <select className="rounded-md border bg-background px-2 py-1.5 text-sm" value={targetLang} disabled={busy} onChange={(e) => setTargetLang(e.target.value)}>
                        {LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select>
                    <span className="flex-1" />
                    <Button size="small" disabled={segments.length === 0 || busy} loading={phase.kind === "translate"} onClick={() => void translate()}>
                        翻译字幕
                    </Button>
                    <Button size="small" disabled={segments.length === 0 || busy} onClick={() => void pickHighlights()}>
                        AI 挑高光
                    </Button>
                </section>

                {/* Step 4 配音 */}
                <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="flex items-center gap-2 text-sm font-semibold"><Mic className="size-4" />④ 配音轨(克隆源视频音色)</h2>
                        <span className="flex-1" />
                        <Button size="small" type="primary" disabled={!videoName || segments.length === 0 || busy} loading={phase.kind === "voice"} onClick={() => void doVoice()}>
                            生成配音轨
                        </Button>
                    </div>
                    <input className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" value={emoText} placeholder="情绪提示(可选)" disabled={busy} onChange={(e) => setEmoText(e.target.value)} />
                    {voice && (
                        <div className="flex flex-col gap-1.5 rounded-xl border p-3">
                            <audio src={toivMediaUrl(voice.url)} controls className="w-full" />
                            <p className="text-xs text-muted-foreground">{voice.segment_count} 段 · {Math.round(voice.duration)}s · {voice.url.split("/").pop()}</p>
                        </div>
                    )}
                </section>

                {/* Step 5 对口型 */}
                <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="flex items-center gap-2 text-sm font-semibold">⑤ 对口型成片</h2>
                        <span className="flex-1" />
                        <Button size="small" type="primary" disabled={!videoName || busy} loading={phase.kind === "lipsync"} onClick={() => void doLipsync()}>
                            生成对口型成片
                        </Button>
                        <Button size="small" disabled={!videoName || busy} loading={phase.kind === "anime"} onClick={() => void doAnimeLipsync()}>
                            动漫口型(轻量)
                        </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>自动切段:</span>
                        <select className="rounded-md border bg-background px-2 py-1" value={autocutMode} disabled={busy} onChange={(e) => setAutocutMode(e.target.value as "scene" | "silence")}>
                            <option value="scene">场景切换</option>
                            <option value="silence">静音检测</option>
                        </select>
                        <Button size="small" variant="text" disabled={!videoName || busy} onClick={() => void runAutocut()}>
                            运行切段(更新分段)
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">用源视频(或上一步配音轨)驱动口型;未生成配音轨时用源视频自带音轨。动漫口型为本地 CV 轻量方案(非 LatentSync)。</p>
                    {lipsyncUrl ? (
                        <video src={toivMediaUrl(lipsyncUrl)} controls playsInline className="max-h-[420px] w-full rounded-lg bg-black/5" />
                    ) : (
                        !busy && <EmptyState description="完成上一步后生成对口型成片" />
                    )}
                </section>
            </div>
        </WorkspacePage>
    );
}
