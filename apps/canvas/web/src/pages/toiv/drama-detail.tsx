import { AudioLines, ChevronRight, IdCard, MessagesSquare, PlayCircle, Upload } from "lucide-react";
import { ArrowLeft, Clapperboard, ExternalLink, Film, Loader2, RefreshCw, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { EmptyState } from "@/components/ui/product/empty-state";
import { appendCChainSegments, buildMakeupCChainFromDrama, cancelJob, createCChain, fetchCChain, fetchCharacterSheets, fetchDramaProject, pickCChainSegment, triggerBatchRender, triggerPanelReplace, triggerSheetRegen, triggerShotLipsync, triggerShotRender, triggerShotVoice, type ToivCChainDetail, type ToivCharacterSheet, type ToivDramaDetail } from "@/services/toiv/client";
import { WorkspacePage } from "@/components/layout/workspace-page";

const SHOT_STATUS: Record<string, { tone: "neutral" | "loading" | "success" | "error" | "warning"; text: string }> = {
    draft: { tone: "neutral", text: "草稿" },
    rendering: { tone: "loading", text: "渲染中" },
    rendered: { tone: "success", text: "已出片" },
    voiced: { tone: "success", text: "已配音" },
    error: { tone: "error", text: "失败" },
};

const primaryBtn = "inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-md bg-foreground px-2.5 text-caption font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4";

export default function DramaDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [detail, setDetail] = useState<ToivDramaDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [renderingShots, setRenderingShots] = useState<Set<string>>(new Set());
    const [voicingShots, setVoicingShots] = useState<Set<string>>(new Set());
    const [lipsyncingShots, setLipsyncingShots] = useState<Set<string>>(new Set());
    const [charDetail, setCharDetail] = useState<{ char: NonNullable<ToivDramaDetail["characters"]>[number]; sheets: ToivCharacterSheet[] } | null>(null);
    const [sheetsLoading, setSheetsLoading] = useState(false);
    const [regenStyle, setRegenStyle] = useState<string | null>(null);
    const [replacingKey, setReplacingKey] = useState<string | null>(null);
    const [batchRendering, setBatchRendering] = useState(false);
    const [chainJobId, setChainJobId] = useState<string | null>(null);
    const [chainBusy, setChainBusy] = useState(false);
    const [chainNote, setChainNote] = useState<string | null>(null);
    const [chainDetail, setChainDetail] = useState<ToivCChainDetail | null>(null);
    const [appendPrompt, setAppendPrompt] = useState("");
    const [pickingId, setPickingId] = useState<string | null>(null);
    const [appending, setAppending] = useState(false);

    const openCharacter = useCallback(async (char: NonNullable<ToivDramaDetail["characters"]>[number]) => {
        setCharDetail({ char, sheets: [] });
        setSheetsLoading(true);
        try { setCharDetail({ char, sheets: await fetchCharacterSheets(char.id) }); }
        catch { /* sheets 失败静默,基础信息仍展示 */ }
        finally { setSheetsLoading(false); }
    }, []);

    const load = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        setLoadFailed(false);
        try { setDetail(await fetchDramaProject(id)); }
        catch { setLoadFailed(true); setDetail(null); }
        finally { setLoading(false); }
    }, [id]);

    useEffect(() => { void load(); }, [load]);
    // 渲染轮询(M3 末项):本页存在渲染中(乐观或后端态)时 15s 拉一次项目
    const busy = batchRendering || chainBusy || (detail?.shots ?? []).some((s) => renderingShots.has(s.id) || voicingShots.has(s.id) || lipsyncingShots.has(s.id) || ["rendering", "voicing", "lipsyncing"].includes(s.status));
    useEffect(() => {
        if (!busy || !id) return;
        const t = window.setInterval(() => { void fetchDramaProject(id).then(setDetail).catch(() => {}); }, 15000);
        return () => window.clearInterval(t);
    }, [busy, id]);

    useEffect(() => {
        if (!id) return;
        void fetchCChain(id).then(setChainDetail).catch(() => setChainDetail(null));
    }, [id, detail?.updated_at]);

    useEffect(() => {
        if (!chainBusy || !id || !chainJobId) return;
        const tick = () => {
            void fetchCChain(id)
                .then((chain) => {
                    setChainDetail(chain);
                    const active = chain.active_job_id;
                    if (!active || active !== chainJobId) {
                        setChainBusy(false);
                        setChainNote(chain.final_url ? "管线C已完成" : "管线C已结束");
                        void fetchDramaProject(id).then(setDetail).catch(() => {});
                        return;
                    }
                    const done = (chain.segments ?? []).filter((s) => s.status === "done" || s.shot_status === "rendered").length;
                    const total = (chain.segments ?? []).length || 0;
                    setChainNote(`管线C进行中 ${done}/${total} · job ${chainJobId.slice(0, 8)}`);
                })
                .catch(() => {});
        };
        tick();
        const timer = window.setInterval(tick, 8000);
        return () => window.clearInterval(timer);
    }, [chainBusy, chainJobId, id]);

    if (loading) return (
        <WorkspacePage fluid className="toiv-drama-detail-page">
            <div className="flex h-full items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
        </WorkspacePage>
    );
    if (!detail) return (
        <WorkspacePage fluid className="toiv-drama-detail-page">
            <div className="flex h-full items-center justify-center"><EmptyState description={loadFailed ? "项目不存在或读取失败" : "项目不存在或读取失败"} /></div>
        </WorkspacePage>
    );

    const shots = detail.shots ?? [];
    const chars = detail.characters ?? [];

    return (
        <WorkspacePage fluid className="toiv-drama-detail-page">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6">
            <header className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                    <h1 className="truncate text-xl font-semibold leading-7 text-foreground">{detail.title || detail.premise?.slice(0, 30) || "未命名项目"}</h1>
                    <p className="line-clamp-1 text-xs leading-5 text-muted-foreground">{detail.premise}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{shots.length} 个分镜</span>
                        <span>· {detail.width}×{detail.height} @{detail.fps}fps</span>
                        <span>· 管线 {detail.render_mode_default ?? "video"}</span>
                    </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            className={primaryBtn}
                            disabled={batchRendering || chainBusy}
                            aria-busy={batchRendering || undefined}
                            onClick={() => { setBatchRendering(true); void triggerBatchRender(detail.id).finally(() => setBatchRendering(false)); }}
                        >
                            {batchRendering ? <Loader2 className="animate-spin" aria-hidden /> : <PlayCircle aria-hidden />}
                            <span>渲染全部</span>
                        </button>
                        <button
                            type="button"
                            className={primaryBtn}
                            disabled={batchRendering || chainBusy}
                            aria-busy={chainBusy || undefined}
                            title="异步 c-chains（makeup）；取消用顶层 job_id"
                            onClick={() => {
                                setChainNote(null);
                                try {
                                    const body = buildMakeupCChainFromDrama(detail, { num_candidates: 2, auto_assemble: true });
                                    setChainBusy(true);
                                    void createCChain(body)
                                        .then((ack) => {
                                            setChainJobId(ack.job_id);
                                            setChainNote(`已排队 job ${ack.job_id.slice(0, 8)}（取消走顶层 job_id）`);
                                            void fetchCChain(detail.id).then(setChainDetail).catch(() => {});
                                        })
                                        .catch((err: unknown) => {
                                            setChainBusy(false);
                                            setChainJobId(null);
                                            setChainNote(err instanceof Error ? err.message : "管线C启动失败");
                                        });
                                } catch (err) {
                                    setChainBusy(false);
                                    setChainNote(err instanceof Error ? err.message : "无法启动管线C");
                                }
                            }}
                        >
                            {chainBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Clapperboard aria-hidden />}
                            <span>管线C</span>
                        </button>
                        {chainBusy && chainJobId ? (
                            <ToolButton
                                variant="default"
                                icon={<Film />}
                                label="取消管线C"
                                onClick={() => {
                                    void cancelJob(chainJobId).then((ok) => {
                                        setChainBusy(false);
                                        setChainNote(ok ? "已请求取消（顶层 job_id）" : "取消失败");
                                    });
                                }}
                            />
                        ) : null}
                        <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} />
                        <a
                            href={`/drama/${detail.id}?classic=1`}
                            className="inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-[var(--r-md,12px)] border border-border px-2.5 text-caption font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title="完整分镜编辑仍在旧工作台；本页已支持管线C与出片预览"
                        >
                            <ExternalLink aria-hidden />
                            <span>完整编辑（迁移中）</span>
                        </a>
                    </div>
                    {chainNote ? <p className="max-w-md text-right text-xs text-muted-foreground">{chainNote}</p> : null}
                </div>
            </header>

            {detail.final_url && (
                <section className="overflow-hidden rounded-2xl border border-border">
                    <video src={detail.final_url} controls className="max-h-[60vh] w-full bg-black" />
                </section>
            )}

            {(() => {
                const segs = chainDetail?.segments ?? [];
                const tail = segs.length ? segs[segs.length - 1] : null;
                const cands = (tail?.candidates ?? []).filter((c) => c && typeof c.id === "string");
                const canPick = !chainBusy && !pickingId && cands.length > 0;
                const canAppend = !chainBusy && !appending;
                if (!chainDetail && !cands.length) return null;
                return (
                    <section aria-label="管线C候选与续段" className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
                        <div className="flex items-center justify-between gap-2">
                            <h2 className="text-sm font-semibold">管线C · 链尾候选</h2>
                            <span className="text-xs text-muted-foreground">
                                {segs.length ? `共 ${segs.length} 段` : "尚无链"}
                                {chainDetail?.active_job_id ? " · 作业中" : ""}
                            </span>
                        </div>
                        {cands.length === 0 ? (
                            <p className="text-xs text-muted-foreground">链尾暂无候选；出片后可在此改选（仅尾段）。</p>
                        ) : (
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                                {cands.map((c) => (
                                    <div key={c.id} className="flex flex-col gap-2 rounded-xl border border-border p-2">
                                        {c.url || c.first_frame ? (
                                            c.url ? (
                                                <video src={c.url} className="aspect-[9/16] w-full rounded-lg bg-black object-cover" muted playsInline controls={false} />
                                            ) : (
                                                <img src={c.first_frame} alt="" className="aspect-[9/16] w-full rounded-lg object-cover" loading="lazy" />
                                            )
                                        ) : (
                                            <div className="flex aspect-[9/16] items-center justify-center rounded-lg bg-black/40 text-xs text-muted-foreground">{c.id.slice(0, 8)}</div>
                                        )}
                                        <div className="flex items-center justify-between gap-1">
                                            {c.is_picked ? <StatusBadge variant="filled" tone="success" label="已选" size="sm" /> : <StatusBadge variant="filled" tone="neutral" label={c.status || "候选"} size="sm" />}
                                            <button
                                                type="button"
                                                className={primaryBtn}
                                                disabled={!canPick || !!c.is_picked}
                                                onClick={() => {
                                                    if (!id || tail == null) return;
                                                    setPickingId(c.id);
                                                    void pickCChainSegment(id, tail.index, c.id)
                                                        .then((next) => {
                                                            setChainDetail(next);
                                                            setChainNote(`已选候选 ${c.id.slice(0, 8)}`);
                                                            void fetchDramaProject(id).then(setDetail).catch(() => {});
                                                        })
                                                        .catch((err: unknown) => setChainNote(err instanceof Error ? err.message : "改选失败"))
                                                        .finally(() => setPickingId(null));
                                                }}
                                            >
                                                {pickingId === c.id ? <Loader2 className="animate-spin" aria-hidden /> : null}
                                                <span>{c.is_picked ? "当前" : "选用"}</span>
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                            <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-xs text-muted-foreground">
                                续段文案
                                <input
                                    value={appendPrompt}
                                    onChange={(e) => setAppendPrompt(e.target.value)}
                                    disabled={!canAppend}
                                    placeholder="追加一段 prompt（makeup）"
                                    className="h-8 rounded-md border border-border bg-transparent px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45"
                                />
                            </label>
                            <button
                                type="button"
                                className={primaryBtn}
                                disabled={!canAppend || !appendPrompt.trim()}
                                onClick={() => {
                                    if (!id) return;
                                    const prompt = appendPrompt.trim();
                                    if (!prompt) return;
                                    setAppending(true);
                                    void appendCChainSegments(id, {
                                        segments: [{ prompt, duration_sec: 6 }],
                                        num_candidates: 2,
                                        auto_assemble: true,
                                    })
                                        .then((ack) => {
                                            setChainJobId(ack.job_id);
                                            setChainBusy(true);
                                            setAppendPrompt("");
                                            setChainNote(`续段已排队 job ${ack.job_id.slice(0, 8)}`);
                                            void fetchCChain(id).then(setChainDetail).catch(() => {});
                                        })
                                        .catch((err: unknown) => setChainNote(err instanceof Error ? err.message : "续段失败"))
                                        .finally(() => setAppending(false));
                                }}
                            >
                                {appending ? <Loader2 className="animate-spin" aria-hidden /> : <Clapperboard aria-hidden />}
                                <span>续段</span>
                            </button>
                        </div>
                    </section>
                );
            })()}

            <section aria-label="角色与设定卡" className="flex flex-col gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><User className="h-4 w-4" />角色与设定卡（{chars.length}）</h2>
                {chars.length === 0 ? <EmptyState size="compact" description="暂无角色" /> : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                        {chars.map((c) => {
                            const refs = Object.values(c.reference_images_by_style ?? {}).flat().filter(Boolean) as string[];
                            return (
                                <button key={c.id} type="button" onClick={() => void openCharacter(c)}
                                    className="flex gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:border-[var(--workspace-accent,#555)]">
                                    {refs[0] && <img src={refs[0]} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" loading="lazy" />}
                                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                                        <div className="flex items-center gap-1">
                                            <p className="truncate text-sm font-medium">{c.name || "未命名"}</p>
                                            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                        </div>
                                        <p className="line-clamp-3 text-xs text-muted-foreground">{c.description || c.visual_prompt}</p>
                                        {c.voice_ref_url && <StatusBadge variant="filled" tone="neutral" label="已配音色" size="sm" className="mt-auto self-start" />}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </section>

            <section aria-label="分镜板" className="flex flex-col gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><Clapperboard className="h-4 w-4" />分镜板（{shots.length}）</h2>
                <div className="flex flex-col gap-2">
                    {shots.map((s) => {
                        const meta = SHOT_STATUS[s.status] ?? { tone: "neutral" as const, text: s.status };
                        const media = s.video_url || s.final_clip_url || s.image_url;
                        return (
                            <div key={s.id} className="flex items-stretch gap-3 rounded-2xl border border-border bg-card p-3">
                                <div className="flex w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))]">
                                    {media
                                        ? (s.video_url || s.final_clip_url
                                            ? <video src={s.video_url || s.final_clip_url} className="h-full w-full object-cover" muted preload="metadata" />
                                            : <img src={s.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />)
                                        : <Film className="h-6 w-6 text-muted-foreground" />}
                                </div>
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs font-semibold text-muted-foreground">#{Number(s.idx) + 1}</span>
                                        {s.status === "voiced" && (
                                            <ToolButton size="xs" icon={<MessagesSquare />} label="对口型" loading={lipsyncingShots.has(s.id)}
                                                onClick={() => {
                                                    setLipsyncingShots((prev) => new Set(prev).add(s.id));
                                                    void triggerShotLipsync(s.id).finally(() => setLipsyncingShots((prev) => { const n = new Set(prev); n.delete(s.id); return n; }));
                                                }} />
                                        )}
                                        {s.status === "rendered" && !s.voice_url && (
                                            <ToolButton size="xs" icon={<AudioLines />} label="配音" loading={voicingShots.has(s.id)}
                                                onClick={() => {
                                                    setVoicingShots((prev) => new Set(prev).add(s.id));
                                                    void triggerShotVoice(s.id).finally(() => setVoicingShots((prev) => { const n = new Set(prev); n.delete(s.id); return n; }));
                                                }} />
                                        )}
                                        {!["rendering", "rendered", "voiced", "lipsynced", "done"].includes(s.status) && (
                                            <ToolButton size="xs" icon={<PlayCircle />} label="渲染" loading={renderingShots.has(s.id)}
                                                onClick={() => {
                                                    setRenderingShots((prev) => new Set(prev).add(s.id));
                                                    void triggerShotRender(s.id).finally(() => setRenderingShots((prev) => { const n = new Set(prev); n.delete(s.id); return n; }));
                                                }} />
                                        )}
                                        <StatusBadge variant="filled" tone={meta.tone} label={meta.text} size="sm" />
                                        <span className="text-[11px] text-muted-foreground">{s.duration_sec}s · {s.render_mode}</span>
                                        {s.speaker && <span className="text-[11px] text-muted-foreground">🗣 {s.speaker}</span>}
                                    </div>
                                    <p className="line-clamp-2 text-xs leading-relaxed">{s.scene || s.prompt}</p>
                                    {s.dialogue && <p className="truncate text-xs italic text-muted-foreground">「{s.dialogue}」</p>}
                                    {s.camera && <p className="truncate text-[11px] text-muted-foreground">🎥 {s.camera}</p>}
                                    {s.error && <p className="text-[11px] text-red-400">{s.error}</p>}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            <footer>
                <Link to="/toiv/drama"><ToolButton variant="default" icon={<ArrowLeft />} label="返回项目列表" /></Link>
            </footer>
            <AppDrawer open={!!charDetail} onClose={() => setCharDetail(null)} width={480} title={charDetail?.char?.name || "角色"}>
                {charDetail && (
                    <div className="flex flex-col gap-4">
                        <p className="text-sm leading-relaxed">{charDetail.char.description || charDetail.char.visual_prompt}</p>
                        {charDetail.char.visual_prompt && (
                            <p className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs leading-relaxed text-muted-foreground">{charDetail.char.visual_prompt}</p>
                        )}
                        {charDetail.char.voice_ref_url && (
                            <div className="flex flex-col gap-1">
                                <span className="text-xs font-medium">音色试听</span>
                                <audio controls src={charDetail.char.voice_ref_url} className="w-full" />
                            </div>
                        )}
                        <div className="flex flex-col gap-2">
                            <span className="text-xs font-medium">设定卡（{charDetail.sheets.length}）</span>
                            {sheetsLoading ? <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="加载中" /> : charDetail.sheets.length === 0 ? (
                                <div className="flex flex-col gap-2">
                                    <EmptyState size="compact" description="暂无设定卡,选择风格生成:" />
                                    <div className="flex justify-center gap-2">
                                        {["ancient_realistic", "anime"].map((st) => (
                                            <ToolButton key={st} size="sm" variant="default" icon={<IdCard />} label={st === "ancient_realistic" ? "古风写实" : "二次元"}
                                                loading={regenStyle === st}
                                                onClick={() => {
                                                    const cid = charDetail.char.id;
                                                    setRegenStyle(st);
                                                    void triggerSheetRegen(cid, st).finally(() => {
                                                        setRegenStyle(null);
                                                        void fetchCharacterSheets(cid).then((sheets) => setCharDetail((prev) => (prev ? { ...prev, sheets } : prev))).catch(() => {});
                                                    });
                                                }} />
                                        ))}
                                    </div>
                                </div>
                            ) : charDetail.sheets.map((sh) => (
                                <div key={sh.style} className="flex flex-col gap-1.5 rounded-xl border border-border p-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] text-muted-foreground">{sh.style}{sh.mtime ? ` · ${new Date(sh.mtime).toLocaleDateString("zh-CN")}` : ""}</span>
                                        <ToolButton size="xs" icon={<IdCard />} label="重生成" loading={regenStyle === sh.style}
                                            onClick={() => {
                                                if (!charDetail) return;
                                                setRegenStyle(sh.style);
                                                const cid = charDetail.char.id;
                                                void triggerSheetRegen(cid, sh.style).finally(() => {
                                                    setRegenStyle(null);
                                                    void fetchCharacterSheets(cid).then((sheets) => setCharDetail((prev) => (prev ? { ...prev, sheets } : prev))).catch(() => {});
                                                });
                                            }} />
                                    </div>
                                    {sh.sheet_url && <img src={sh.sheet_url} alt="" className="w-full rounded-lg" loading="lazy" />}
                                    {(sh.panel_urls ?? []).length > 0 && (
                                        <div className="grid grid-cols-3 gap-1">
                                            {sh.panel_urls!.slice(0, 9).map((p, i) => {
                                                const panelKeys = ["portrait", "front", "side", "back", "faces", "costume", "expr_0", "expr_1", "expr_2"];
                                                const pk = panelKeys[i] ?? `expr_${i - 6}`;
                                                return (
                                                    <div key={i} className="group relative">
                                                        <img src={p} alt="" className="aspect-square w-full rounded-md object-cover" loading="lazy" />
                                                        <label className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-black/60 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                                                            {replacingKey === pk ? "替换中…" : <><Upload className="mr-1 h-3 w-3" />替换</>}
                                                            <input type="file" accept="image/*" className="hidden"
                                                                disabled={replacingKey !== null}
                                                                onChange={async (ev) => {
                                                                    const file = ev.target.files?.[0];
                                                                    ev.target.value = "";
                                                                    if (!file || !charDetail) return;
                                                                    const b64 = await new Promise<string>((res, rej) => {
                                                                        const fr = new FileReader();
                                                                        fr.onload = () => res(String(fr.result));
                                                                        fr.onerror = rej;
                                                                        fr.readAsDataURL(file);
                                                                    });
                                                                    setReplacingKey(pk);
                                                                    const cid = charDetail.char.id;
                                                                    void triggerPanelReplace(cid, sh.style, pk, b64).finally(() => {
                                                                        setReplacingKey(null);
                                                                        void fetchCharacterSheets(cid).then((sheets2) => setCharDetail((prev) => (prev ? { ...prev, sheets: sheets2 } : prev))).catch(() => {});
                                                                    });
                                                                }} />
                                                        </label>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </AppDrawer>
        </div>
        </WorkspacePage>
    );
}
