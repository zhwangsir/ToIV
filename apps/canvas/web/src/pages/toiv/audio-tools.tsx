import { ArrowLeft, AudioLines, FileAudio, Loader2, Mic, Scissors, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { Button } from "antd";
import { ToolButton } from "@/components/ui/base/buttons";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import {
    pollDubTranscribe,
    separateAudioFile,
    startDubTranscribe,
    synthVoice,
    uploadDubMedia,
    uploadVoiceRefAudio,
    type AudioSeparateResult,
    type DubSegment,
    type VoiceSynthResult,
} from "@/services/toiv/client";
import { toivMediaUrl } from "@/services/toiv/agent-runs";

/**
 * 音频工具(F4 融合,自经典 AudioView 编辑三工具迁入):
 * TTS 配音(IndexTTS2,参考音克隆) / ASR 听写(whisper 后台作业+进度) / 人声分离(Demucs 干声)。
 * 音频生成(文生音乐)走工具箱应用市场,不在此页。
 */

type Tool = "tts" | "asr" | "separate";

const TOOLS: { key: Tool; icon: typeof Mic; name: string; desc: string }[] = [
    { key: "tts", icon: Mic, name: "TTS 配音", desc: "文本转语音(IndexTTS2),可上传参考音克隆音色" },
    { key: "asr", icon: FileAudio, name: "ASR 听写", desc: "上传音视频,whisper 转写为带时间轴的文本" },
    { key: "separate", icon: Scissors, name: "人声分离", desc: "Demucs 从音频分离人声,输出干声 wav" },
];

const AUDIO_EXTS = ["mp3", "wav", "flac", "ogg", "m4a"];
const MEDIA_EXTS = [...AUDIO_EXTS, "mp4", "webm", "mov", "mkv"];
const SEP_MAX_BYTES = 50 * 1024 * 1024;

function fileExt(name: string): string {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── TTS 配音 ──

function TtsTool() {
    const [text, setText] = useState("");
    const [emo, setEmo] = useState("");
    const [ref, setRef] = useState<File | null>(null);
    const [refInfo, setRefInfo] = useState<VoiceSynthResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<VoiceSynthResult | null>(null);

    const uploadRef = async (f: File) => {
        setError(null);
        setBusy(true);
        setPhase("参考音归一化…");
        try {
            const r = await uploadVoiceRefAudio(f);
            setRef(f);
            setRefInfo(r);
        } catch (e) {
            setError(e instanceof Error ? e.message : "参考音上传失败");
        } finally {
            setBusy(false);
            setPhase("");
        }
    };

    const submit = async () => {
        if (!text.trim() || busy) return;
        setBusy(true);
        setError(null);
        setResult(null);
        setPhase("合成中(IndexTTS2,约几十秒)…");
        try {
            const r = await synthVoice({
                text: text.trim().slice(0, 600),
                ...(emo.trim() ? { emo_text: emo.trim().slice(0, 200) } : {}),
                ...(refInfo ? { ref_audio_url: refInfo.url } : {}),
            });
            setResult(r);
        } catch (e) {
            setError(e instanceof Error ? e.message : "配音合成失败");
        } finally {
            setBusy(false);
            setPhase("");
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <textarea
                className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
                value={text}
                placeholder="输入要配音的文本(600 字以内)…"
                maxLength={600}
                onChange={(e) => setText(e.target.value)}
            />
            <input
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={emo}
                placeholder="情绪提示(可选,如:轻柔地、兴奋地)"
                onChange={(e) => setEmo(e.target.value)}
            />
            <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-surface-hover">
                    <Upload className="size-4" />
                    <span>{refInfo ? "换参考音" : "上传参考音(克隆音色)"}</span>
                    <input
                        type="file" className="hidden" accept=".mp3,.wav,.flac,.ogg,.m4a"
                        onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void uploadRef(f); }}
                    />
                </label>
                {refInfo && (
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={ref?.name}>
                        {ref?.name} · {Math.round(refInfo.duration_sec)}s
                        <button type="button" className="ml-2 underline" onClick={() => { setRef(null); setRefInfo(null); }}>移除</button>
                    </span>
                )}
            </div>
            {error && <Callout tone="error" title={error} onClose={() => setError(null)} />}
            {phase && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{phase}</p>}
            {result && (
                <div className="flex flex-col gap-2 rounded-xl border p-3">
                    <audio src={toivMediaUrl(result.url)} controls className="w-full" />
                    <p className="text-xs text-muted-foreground">{Math.round(result.duration_sec)}s · {result.name}</p>
                </div>
            )}
            <div className="flex justify-end">
                <Button type="primary" size="small" icon={<Mic className="size-3.5" />} loading={busy} disabled={!text.trim()} onClick={() => void submit()}>
                    合成配音
                </Button>
            </div>
        </div>
    );
}

// ── ASR 听写 ──

function AsrTool() {
    const [file, setFile] = useState<File | null>(null);
    const [uploadPct, setUploadPct] = useState(0);
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [segments, setSegments] = useState<DubSegment[]>([]);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

    const submit = async (f: File) => {
        if (busy) return;
        setFile(f);
        setSegments([]);
        setError(null);
        setBusy(true);
        setPhase(`上传中 ${uploadPct}%`);
        try {
            const up = await uploadDubMedia(f, (p) => { setUploadPct(p); setPhase(`上传中 ${p}%`); });
            setPhase("听写排队…");
            const { job_id } = await startDubTranscribe(up.name);
            await new Promise<void>((resolve, reject) => {
                pollRef.current = setInterval(async () => {
                    try {
                        const st = await pollDubTranscribe(job_id);
                        if (st.status === "done") {
                            if (pollRef.current) clearInterval(pollRef.current);
                            setSegments(st.segments ?? []);
                            setBusy(false);
                            setPhase("");
                        } else if (st.status === "error" || st.status === "canceled") {
                            if (pollRef.current) clearInterval(pollRef.current);
                            reject(new Error(st.error || "听写失败"));
                        } else {
                            setPhase(`${st.stage || "听写中"} ${st.progress ?? 0}%`);
                        }
                    } catch (e) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        reject(e);
                    }
                }, 2000);
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "听写失败");
            setBusy(false);
            setPhase("");
        }
    };

    const copyAll = () => {
        const text = segments.map((s) => `[${fmtTime(s.start)}-${fmtTime(s.end)}] ${s.text}`).join("\n");
        void navigator.clipboard.writeText(text);
    };

    return (
        <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-sm text-muted-foreground transition-colors hover:border-[var(--workspace-accent)]"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void submit(f); }}>
                <Upload className="size-6" />
                <span>{file ? `${file.name}(${(file.size / 1024 / 1024).toFixed(1)}MB)` : "点击或拖入音视频文件(mp4/wav/mp3…)"}</span>
                <span className="text-xs">whisper 后台听写,长视频可能数分钟</span>
                <input type="file" className="hidden" accept={MEDIA_EXTS.map((e) => `.${e}`).join(",")} disabled={busy}
                    onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void submit(f); }} />
            </label>
            {error && <Callout tone="error" title={error} onClose={() => setError(null)} />}
            {phase && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{phase}</p>}
            {segments.length > 0 && (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{segments.length} 段转写</span>
                        <Button size="small" onClick={copyAll}>复制全部</Button>
                    </div>
                    <ol className="flex max-h-96 flex-col gap-1.5 overflow-y-auto rounded-xl border p-3 text-sm">
                        {segments.map((s) => (
                            <li key={s.index} className="flex gap-2">
                                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{fmtTime(s.start)}→{fmtTime(s.end)}</span>
                                <span className="min-w-0 flex-1">{s.text}</span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </div>
    );
}

// ── 人声分离 ──

function SeparateTool() {
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<AudioSeparateResult | null>(null);
    const [srcName, setSrcName] = useState("");

    const submit = async (f: File) => {
        if (busy) return;
        if (f.size > SEP_MAX_BYTES) {
            setError(`文件超过 50MB:${f.name}`);
            return;
        }
        if (!AUDIO_EXTS.includes(fileExt(f.name))) {
            setError(`不支持的格式:${f.name}(仅 ${AUDIO_EXTS.join("/")})`);
            return;
        }
        setSrcName(f.name);
        setResult(null);
        setError(null);
        setBusy(true);
        setPhase("Demucs 分离中(约几十秒)…");
        try {
            const r = await separateAudioFile(f);
            setResult(r);
        } catch (e) {
            setError(e instanceof Error ? e.message : "人声分离失败");
        } finally {
            setBusy(false);
            setPhase("");
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-sm text-muted-foreground transition-colors hover:border-[var(--workspace-accent)]"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void submit(f); }}>
                <AudioLines className="size-6" />
                <span>{srcName || "点击或拖入音频文件(mp3/wav/flac/ogg/m4a,≤50MB)"}</span>
                <span className="text-xs">分离出干声 wav(去 BGM,可作克隆参考音)</span>
                <input type="file" className="hidden" accept={AUDIO_EXTS.map((e) => `.${e}`).join(",")} disabled={busy}
                    onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void submit(f); }} />
            </label>
            {error && <Callout tone="error" title={error} onClose={() => setError(null)} />}
            {phase && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{phase}</p>}
            {result && (
                <div className="flex flex-col gap-2 rounded-xl border p-3">
                    <audio src={toivMediaUrl(result.url)} controls className="w-full" />
                    <p className="text-xs text-muted-foreground">
                        干声{result.duration_sec ? ` · ${Math.round(result.duration_sec)}s` : ""}
                        <a className="ml-2 underline" href={toivMediaUrl(result.url)} download>下载</a>
                    </p>
                </div>
            )}
        </div>
    );
}

// ── 页面 ──

export default function AudioToolsPage() {
    const [tool, setTool] = useState<Tool>("tts");
    const active = TOOLS.find((t) => t.key === tool) ?? TOOLS[0];

    const pick = useCallback((k: Tool) => setTool(k), []);

    return (
        <WorkspacePage fluid className="toiv-audio-page">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
                <header className="flex items-center justify-between">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-xl font-semibold leading-7 text-foreground">音频工具</h1>
                        <p className="text-xs leading-5 text-muted-foreground">配音 / 听写 / 人声分离;文生音乐在工具箱应用市场</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link to="/toiv/market"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="工具箱" /></Link>
                        <Link to="/"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="返回首页" /></Link>
                    </div>
                </header>

                <div className="flex gap-2" role="tablist" aria-label="音频工具">
                    {TOOLS.map((t) => (
                        <ToolButton
                            key={t.key}
                            variant={tool === t.key ? "default" : "ghost"}
                            icon={<t.icon className="size-4" />}
                            label={t.name}
                            active={tool === t.key}
                            onClick={() => pick(t.key)}
                        />
                    ))}
                </div>

                <section className="flex flex-col gap-4 rounded-2xl border bg-card p-4" aria-label={active.name}>
                    <div className="flex flex-col gap-0.5">
                        <h2 className="text-sm font-semibold">{active.name}</h2>
                        <p className="text-xs text-muted-foreground">{active.desc}</p>
                    </div>
                    {tool === "tts" ? <TtsTool /> : tool === "asr" ? <AsrTool /> : <SeparateTool />}
                </section>
            </div>
        </WorkspacePage>
    );
}
