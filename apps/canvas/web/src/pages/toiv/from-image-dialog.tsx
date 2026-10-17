import { Images, Loader2, Sparkles, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { Callout } from "@/components/ui/product/callout";
import { ToolButton } from "@/components/ui/base/buttons";
import {
    createAnimaticStitch,
    pollStudioFromImage,
    submitStudioFromImage,
    type AnimaticStitchResult,
} from "@/services/toiv/client";

/**
 * 从图片创建(F3 融合,自经典 animatic 视图迁入):
 * · AI 解析:1-9 张参考图 → VLM 解析 → 建 StudioProject(角色+分镜)→ 跳 v2 工作区;
 * · 快速拼接:1-20 张图 + 每图时长 → 直接拼成片(经典 /api/animatic 小工具直通)。
 */

const AI_MAX = 9;
const STITCH_MAX = 20;
const MAX_BYTES = 20 * 1024 * 1024;
const EXT_OK = ["jpg", "jpeg", "png", "webp"];
const NUM_SHOT_OPTIONS = [4, 6, 8, 10, 12, 14, 16];

type Mode = "ai" | "stitch";

type Item = { id: string; file: File; preview: string };

function fileExt(name: string): string {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function FromImageDialog({
    open,
    onClose,
    onProjectCreated,
}: {
    open: boolean;
    onClose: () => void;
    onProjectCreated: (projectId: string) => void;
}) {
    const [mode, setMode] = useState<Mode>("ai");
    const [items, setItems] = useState<Item[]>([]);
    const [hint, setHint] = useState("");
    const [numShots, setNumShots] = useState(8);
    const [stitchDuration, setStitchDuration] = useState(3);
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState<string>("");
    const [error, setError] = useState<string | null>(null);
    const [stitchResult, setStitchResult] = useState<AnimaticStitchResult | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const cap = mode === "ai" ? AI_MAX : STITCH_MAX;

    const cleanup = useCallback(() => {
        for (const it of items) URL.revokeObjectURL(it.preview);
    }, [items]);

    useEffect(() => {
        if (!open) {
            cleanup();
            setItems([]);
            setHint("");
            setError(null);
            setStitchResult(null);
            setBusy(false);
            setPhase("");
            if (pollRef.current) clearInterval(pollRef.current);
        }
    }, [open, cleanup]);

    const addFiles = (files: FileList | null) => {
        if (!files) return;
        setError(null);
        const next: Item[] = [];
        for (const f of Array.from(files)) {
            if (!EXT_OK.includes(fileExt(f.name))) {
                setError(`不支持的格式:${f.name}(仅 ${EXT_OK.join("/")}）`);
                continue;
            }
            if (f.size > MAX_BYTES) {
                setError(`图片超过 20MB:${f.name}`);
                continue;
            }
            next.push({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`, file: f, preview: URL.createObjectURL(f) });
        }
        setItems((prev) => [...prev, ...next].slice(0, cap));
    };

    const removeItem = (id: string) => {
        setItems((prev) => {
            const it = prev.find((x) => x.id === id);
            if (it) URL.revokeObjectURL(it.preview);
            return prev.filter((x) => x.id !== id);
        });
    };

    const submitAi = async () => {
        if (!items.length || busy) return;
        setBusy(true);
        setError(null);
        setPhase("提交解析…");
        try {
            const { job_id } = await submitStudioFromImage({
                images: items.map((i) => i.file),
                hint: hint.trim() || undefined,
                numShots,
            });
            setPhase("VLM 解析中(1-2 分钟)…");
            await new Promise<void>((resolve, reject) => {
                pollRef.current = setInterval(async () => {
                    try {
                        const st = await pollStudioFromImage(job_id);
                        if (st.status === "done") {
                            if (pollRef.current) clearInterval(pollRef.current);
                            setPhase("");
                            setBusy(false);
                            onProjectCreated(st.project_id);
                        } else if (st.status === "error" || st.status === "canceled") {
                            if (pollRef.current) clearInterval(pollRef.current);
                            reject(new Error(st.error));
                        }
                    } catch (e) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        reject(e);
                    }
                }, 2000);
            });
        } catch (e) {
            setPhase("");
            setBusy(false);
            setError(e instanceof Error ? e.message : "解析失败,请重试");
        }
    };

    const submitStitch = async () => {
        if (!items.length || busy) return;
        setBusy(true);
        setError(null);
        setPhase("拼接中…");
        try {
            const res = await createAnimaticStitch({
                images: items.map((i) => i.file),
                durations: items.map(() => stitchDuration),
                width: 1920,
                height: 1080,
                fps: 16,
            });
            setStitchResult(res);
        } catch (e) {
            setError(e instanceof Error ? e.message : "拼接失败,请重试");
        } finally {
            setPhase("");
            setBusy(false);
        }
    };

    const token = typeof window !== "undefined" ? window.localStorage.getItem("toiv_token") : "";
    const videoUrl = stitchResult
        ? stitchResult.url + (stitchResult.url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token ?? "")
        : "";

    return (
        <AppModal
            open={open}
            title="从图片创建"
            onCancel={() => { if (!busy) onClose(); }}
            footer={null}
            width={640}
        >
            <div className="flex flex-col gap-4">
                <div className="flex gap-2" role="tablist" aria-label="创建模式">
                    <ToolButton variant={mode === "ai" ? "default" : "ghost"} icon={<Sparkles className="size-4" />} label="AI 解析成分镜" active={mode === "ai"} onClick={() => { if (!busy) { setMode("ai"); setStitchResult(null); } }} />
                    <ToolButton variant={mode === "stitch" ? "default" : "ghost"} icon={<Images className="size-4" />} label="快速拼接成片" active={mode === "stitch"} onClick={() => { if (!busy) { setMode("stitch"); setStitchResult(null); } }} />
                </div>

                <label
                    className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-sm text-muted-foreground transition-colors hover:border-[var(--workspace-accent)]"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
                >
                    <Upload className="size-6" />
                    <span>{mode === "ai" ? `点击或拖入参考图(1-${AI_MAX} 张,VLM 解析成短剧分镜)` : `点击或拖入图片(1-${STITCH_MAX} 张,按顺序拼接)`}</span>
                    <span className="text-xs">jpg / jpeg / png / webp · 单张 ≤20MB</span>
                    <input type="file" className="hidden" multiple accept=".jpg,.jpeg,.png,.webp" disabled={busy} onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ""; }} />
                </label>

                {items.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {items.map((it, i) => (
                            <div key={it.id} className="relative size-20 overflow-hidden rounded-lg border bg-secondary">
                                <img src={it.preview} alt={it.file.name} className="size-full object-cover" />
                                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
                                {!busy && (
                                    <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded bg-black/60 text-white hover:bg-destructive" title="移除" onClick={() => removeItem(it.id)}>
                                        <X className="size-3" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {mode === "ai" ? (
                    <div className="flex flex-col gap-3">
                        <textarea
                            className="w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm"
                            rows={2}
                            value={hint}
                            placeholder="补充说明(可选):画风/情绪/主角设定等"
                            onChange={(e) => setHint(e.target.value)}
                        />
                        <div className="flex items-center gap-2 text-sm">
                            <span className="text-muted-foreground">分镜数</span>
                            <div className="flex flex-wrap gap-1">
                                {NUM_SHOT_OPTIONS.map((n) => (
                                    <button key={n} type="button" disabled={busy}
                                        className={`rounded-md px-2 py-1 text-xs transition-colors ${numShots === n ? "bg-[var(--surface-active)] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                                        onClick={() => setNumShots(n)}>
                                        {n}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center gap-3 text-sm">
                        <span className="text-muted-foreground">每图时长</span>
                        <input type="range" min={1} max={10} step={0.5} value={stitchDuration} disabled={busy}
                            onChange={(e) => setStitchDuration(Number(e.target.value))} className="w-40" />
                        <span className="tabular-nums">{stitchDuration}s</span>
                    </div>
                )}

                {error && <Callout tone="error" title={error} onClose={() => setError(null)} />}
                {phase && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> {phase}
                    </p>
                )}

                {stitchResult && videoUrl && (
                    <div className="flex flex-col gap-2 rounded-xl border p-3">
                        <video src={videoUrl} controls playsInline className="max-h-72 w-full rounded-lg bg-black/5" />
                        <p className="text-xs text-muted-foreground">
                            {stitchResult.count} 张 · 总时长 {Math.round(stitchResult.duration)}s · {stitchResult.width}×{stitchResult.height}
                        </p>
                    </div>
                )}

                <div className="flex justify-end gap-2">
                    <Button size="small" disabled={busy} onClick={onClose}>关闭</Button>
                    {mode === "ai" ? (
                        <Button type="primary" size="small" icon={<Sparkles className="size-3.5" />} loading={busy} disabled={!items.length} onClick={() => void submitAi()}>
                            解析并建项目
                        </Button>
                    ) : (
                        <Button type="primary" size="small" icon={<Images className="size-3.5" />} loading={busy} disabled={!items.length} onClick={() => void submitStitch()}>
                            拼接成片
                        </Button>
                    )}
                </div>
            </div>
        </AppModal>
    );
}
