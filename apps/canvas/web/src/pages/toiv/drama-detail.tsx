import { AudioLines, ChevronRight, IdCard, MessagesSquare, PlayCircle, Upload } from "lucide-react";
import { ArrowLeft, Clapperboard, ExternalLink, Film, Loader2, RefreshCw, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { EmptyState } from "@/components/ui/product/empty-state";
import { fetchCharacterSheets, fetchDramaProject, triggerBatchRender, triggerPanelReplace, triggerSheetRegen, triggerShotLipsync, triggerShotRender, triggerShotVoice, type ToivCharacterSheet, type ToivDramaDetail } from "@/services/toiv/client";

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
    const busy = batchRendering || (detail?.shots ?? []).some((s) => renderingShots.has(s.id) || voicingShots.has(s.id) || lipsyncingShots.has(s.id) || ["rendering", "voicing", "lipsyncing"].includes(s.status));
    useEffect(() => {
        if (!busy || !id) return;
        const t = window.setInterval(() => { void fetchDramaProject(id).then(setDetail).catch(() => {}); }, 15000);
        return () => window.clearInterval(t);
    }, [busy, id]);

    if (loading) return <main className="flex h-full items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></main>;
    if (!detail) return <main className="flex h-full items-center justify-center"><EmptyState description={loadFailed ? "项目不存在或读取失败" : "项目不存在或读取失败"} /></main>;

    const shots = detail.shots ?? [];
    const chars = detail.characters ?? [];

    return (
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6">
            <header className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                    <h1 className="truncate text-xl font-semibold leading-7 text-foreground">{detail.title || detail.premise?.slice(0, 30) || "未命名项目"}</h1>
                    <p className="line-clamp-1 text-xs leading-5 text-[var(--muted-foreground,#a8a8a8)]">{detail.premise}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                        <span>{shots.length} 个分镜</span>
                        <span>· {detail.width}×{detail.height} @{detail.fps}fps</span>
                        <span>· 管线 {detail.render_mode_default ?? "video"}</span>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        className={primaryBtn}
                        disabled={batchRendering}
                        aria-busy={batchRendering || undefined}
                        onClick={() => { setBatchRendering(true); void triggerBatchRender(detail.id).finally(() => setBatchRendering(false)); }}
                    >
                        {batchRendering ? <Loader2 className="animate-spin" aria-hidden /> : <PlayCircle aria-hidden />}
                        <span>渲染全部</span>
                    </button>
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} />
                    <a href={`/drama/${detail.id}?classic=1`} className={primaryBtn}>
                        <ExternalLink aria-hidden />
                        <span>在原工作台操作</span>
                    </a>
                </div>
            </header>

            {detail.final_url && (
                <section className="overflow-hidden rounded-2xl border border-[var(--border)]">
                    <video src={detail.final_url} controls className="max-h-[60vh] w-full bg-black" />
                </section>
            )}

            <section aria-label="角色与设定卡" className="flex flex-col gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><User className="h-4 w-4" />角色与设定卡（{chars.length}）</h2>
                {chars.length === 0 ? <EmptyState size="compact" description="暂无角色" /> : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                        {chars.map((c) => {
                            const refs = Object.values(c.reference_images_by_style ?? {}).flat().filter(Boolean) as string[];
                            return (
                                <button key={c.id} type="button" onClick={() => void openCharacter(c)}
                                    className="flex gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)] p-3 text-left transition-colors hover:border-[var(--workspace-accent,#555)]">
                                    {refs[0] && <img src={refs[0]} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" loading="lazy" />}
                                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                                        <div className="flex items-center gap-1">
                                            <p className="truncate text-sm font-medium">{c.name || "未命名"}</p>
                                            <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted-foreground,#a8a8a8)]" />
                                        </div>
                                        <p className="line-clamp-3 text-xs text-[var(--muted-foreground,#a8a8a8)]">{c.description || c.visual_prompt}</p>
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
                            <div key={s.id} className="flex items-stretch gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)] p-3">
                                <div className="flex w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))]">
                                    {media
                                        ? (s.video_url || s.final_clip_url
                                            ? <video src={s.video_url || s.final_clip_url} className="h-full w-full object-cover" muted preload="metadata" />
                                            : <img src={s.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />)
                                        : <Film className="h-6 w-6 text-[var(--muted-foreground,#a8a8a8)]" />}
                                </div>
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs font-semibold text-[var(--muted-foreground,#a8a8a8)]">#{Number(s.idx) + 1}</span>
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
                                        <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{s.duration_sec}s · {s.render_mode}</span>
                                        {s.speaker && <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">🗣 {s.speaker}</span>}
                                    </div>
                                    <p className="line-clamp-2 text-xs leading-relaxed">{s.scene || s.prompt}</p>
                                    {s.dialogue && <p className="truncate text-xs italic text-[var(--muted-foreground,#a8a8a8)]">「{s.dialogue}」</p>}
                                    {s.camera && <p className="truncate text-[11px] text-[var(--muted-foreground,#a8a8a8)]">🎥 {s.camera}</p>}
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
                            <p className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs leading-relaxed text-[var(--muted-foreground,#a8a8a8)]">{charDetail.char.visual_prompt}</p>
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
                                <div key={sh.style} className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] p-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{sh.style}{sh.mtime ? ` · ${new Date(sh.mtime).toLocaleDateString("zh-CN")}` : ""}</span>
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
        </main>
    );
}
