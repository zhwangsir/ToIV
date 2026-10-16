/**
 * FU1 词锚定时间轴视图 v1（hypit 投影）。
 * 消费 shots.beats 的服务端 start/end 投影，不在浏览器重复估时。
 * 支持改词 → 调 reflow-beats 回写时长（声明源=拍文本，时间只是投影）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ToivDramaShot } from "@/services/toiv/client";
import { reflowShotBeats } from "@/services/toiv/client";
import { ToolButton } from "@/components/ui/base/buttons";

export function WordAnchorTimeline({
    shot,
    totalSec,
    disabled = false,
    onUpdated,
    onEditingChange,
}: {
    shot: ToivDramaShot;
    totalSec?: number;
    disabled?: boolean;
    onUpdated?: (patch: Partial<ToivDramaShot>) => void;
    onEditingChange?: (sid: string, editing: boolean) => void;
}) {
    const beats = shot.beats ?? [];
    const [texts, setTexts] = useState<string[] | null>(null);
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);
    const [err, setErr] = useState<string | null>(null);
    const rows = beats.map((beat) => ({ start: beat.start_sec, end: beat.end_sec, beat }));
    const total = shot.duration_sec ?? 0;
    const width = Math.max(total, 1);

    const currentTexts = texts ?? beats.map((b) => b.text ?? "");
    useEffect(() => {
        onEditingChange?.(shot.id, texts !== null || busy);
    }, [shot.id, texts, busy, onEditingChange]);
    useEffect(() => () => onEditingChange?.(shot.id, false), [shot.id, onEditingChange]);

    const submitReflow = useCallback(async () => {
        if (!shot.id || submitting.current || disabled) return;
        submitting.current = true;
        setBusy(true);
        setErr(null);
        try {
            const data = await reflowShotBeats(shot.id, {
                texts: currentTexts,
                total_sec: totalSec ?? shot.duration_sec,
                persist: true,
            });
            onUpdated?.({ beats: data.beats, duration_sec: data.duration_sec, dialogue: data.dialogue, prompt: data.prompt });
            setTexts(null);
        } catch (e) {
            setErr(e instanceof Error ? e.message : "重排失败");
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }, [shot.id, shot.duration_sec, totalSec, currentTexts, disabled, onUpdated]);

    if (!beats.length) return null;

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                <span className="font-medium text-foreground">词锚时间轴</span>
                <span>{beats.length} 拍 · {total.toFixed(1)}s（服务端投影）</span>
                <ToolButton
                    size="xs"
                    variant="ghost"
                    label={busy ? "重排中…" : texts ? "应用改词重排" : "改词后点此重排"}
                    loading={busy}
                    disabled={disabled || busy}
                    onClick={() => void submitReflow()}
                />
            </div>
            {err && <p className="text-xs text-[var(--danger,#e5484d)]">{err}</p>}
            <div className="flex h-6 w-full overflow-hidden rounded border border-[var(--border)]">
                {rows.map((r, i) => {
                    const hasAnchor = !!(r.beat.anchor_words && r.beat.anchor_words.trim());
                    const pct = ((r.end - r.start) / width) * 100;
                    return (
                        <div
                            key={i}
                            title={`${r.start.toFixed(1)}–${r.end.toFixed(1)}s${
                                r.beat.cues?.length ? ` · cue:${r.beat.cues.join("/")}` : ""
                            }${hasAnchor ? ` · 锚:${r.beat.anchor_words}` : ""}`}
                            className={`flex items-center justify-center border-r border-[var(--border)] text-[10px] ${
                                hasAnchor
                                    ? "bg-[var(--accent,#6e56cf)] text-white"
                                    : i % 2
                                        ? "bg-[var(--muted,#1e1e20)] text-[var(--muted-foreground,#a8a8a8)]"
                                        : "bg-[var(--card,#121214)] text-[var(--muted-foreground,#a8a8a8)]"
                            }`}
                            style={{ width: `${pct}%` }}
                        >
                            <span className="truncate px-1">{i + 1}</span>
                        </div>
                    );
                })}
            </div>
            <ol className="flex flex-col gap-1">
                {rows.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                        <span className="w-16 shrink-0 tabular-nums text-[var(--muted-foreground,#a8a8a8)]">
                            {r.start.toFixed(1)}–{r.end.toFixed(1)}s
                        </span>
                        <input
                            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-xs text-foreground"
                            value={currentTexts[i] ?? ""}
                            disabled={busy || disabled}
                            aria-label={`第 ${i + 1} 拍台词`}
                            onChange={(e) => {
                                const next = [...currentTexts];
                                next[i] = e.target.value;
                                setTexts(next);
                            }}
                        />
                        <span className="shrink-0 text-[10px] text-[var(--muted-foreground,#a8a8a8)]">
                            {r.beat.cues?.length ? r.beat.cues.map((c) => `@${c}`).join(" ") : ""}
                            {r.beat.anchor_words ? ` 锚:${r.beat.anchor_words}` : ""}
                        </span>
                    </li>
                ))}
            </ol>
        </div>
    );
}
