import { App as AntApp, Button, Drawer, Empty, Spin, Tag, Typography } from "antd";
import { AudioLines, ChevronRight, MessagesSquare, PlayCircle } from "lucide-react";
import { ArrowLeft, Clapperboard, ExternalLink, Film, RefreshCw, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { fetchCharacterSheets, fetchDramaProject, triggerBatchRender, triggerShotLipsync, triggerShotRender, triggerShotVoice, type ToivCharacterSheet, type ToivDramaDetail } from "@/services/toiv/client";

const SHOT_STATUS: Record<string, { color: string; text: string }> = {
    draft: { color: "default", text: "草稿" },
    rendering: { color: "processing", text: "渲染中" },
    rendered: { color: "cyan", text: "已出片" },
    voiced: { color: "processing", text: "已配音" },
    error: { color: "error", text: "失败" },
};

export default function DramaDetailPage() {
    const { id } = useParams<{ id: string }>();
    const { message } = AntApp.useApp();
    const [detail, setDetail] = useState<ToivDramaDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [renderingShots, setRenderingShots] = useState<Set<string>>(new Set());
    const [voicingShots, setVoicingShots] = useState<Set<string>>(new Set());
    const [lipsyncingShots, setLipsyncingShots] = useState<Set<string>>(new Set());
    const [charDetail, setCharDetail] = useState<{ char: NonNullable<ToivDramaDetail["characters"]>[number]; sheets: ToivCharacterSheet[] } | null>(null);
    const [sheetsLoading, setSheetsLoading] = useState(false);
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
        try { setDetail(await fetchDramaProject(id)); }
        catch { message.error("项目详情读取失败"); }
        finally { setLoading(false); }
    }, [id, message]);

    useEffect(() => { void load(); }, [load]);
    // 渲染轮询(M3 末项):本页存在渲染中(乐观或后端态)时 15s 拉一次项目
    const busy = batchRendering || (detail?.shots ?? []).some((s) => renderingShots.has(s.id) || voicingShots.has(s.id) || lipsyncingShots.has(s.id) || ["rendering", "voicing", "lipsyncing"].includes(s.status));
    useEffect(() => {
        if (!busy || !id) return;
        const t = window.setInterval(() => { void fetchDramaProject(id).then(setDetail).catch(() => {}); }, 15000);
        return () => window.clearInterval(t);
    }, [busy, id]);

    if (loading) return <main className="flex h-full items-center justify-center"><Spin /></main>;
    if (!detail) return <main className="flex h-full items-center justify-center"><Empty description="项目不存在或读取失败" /></main>;

    const shots = detail.shots ?? [];
    const chars = detail.characters ?? [];

    return (
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6">
            <header className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                    <Typography.Title level={3} className="!mb-0 truncate">{detail.title || detail.premise?.slice(0, 30) || "未命名项目"}</Typography.Title>
                    <Typography.Text type="secondary" className="line-clamp-1">{detail.premise}</Typography.Text>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                        <span>{shots.length} 个分镜</span>
                        <span>· {detail.width}×{detail.height} @{detail.fps}fps</span>
                        <span>· 管线 {detail.render_mode_default ?? "video"}</span>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Button type="primary" icon={<PlayCircle className="h-3.5 w-3.5" />} loading={batchRendering}
                        onClick={() => { setBatchRendering(true); void triggerBatchRender(detail.id).finally(() => setBatchRendering(false)); }}>
                        渲染全部
                    </Button>
                    <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()}>刷新</Button>
                    <a href={`/drama/${detail.id}?classic=1`}><Button type="primary" icon={<ExternalLink className="h-3.5 w-3.5" />}>在原工作台操作</Button></a>
                </div>
            </header>

            {detail.final_url && (
                <section className="overflow-hidden rounded-2xl border border-[var(--border)]">
                    <video src={detail.final_url} controls className="max-h-[60vh] w-full bg-black" />
                </section>
            )}

            <section aria-label="角色与设定卡" className="flex flex-col gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><User className="h-4 w-4" />角色与设定卡（{chars.length}）</h2>
                {chars.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无角色" /> : (
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
                                        {c.voice_ref_url && <Tag bordered={false} className="mt-auto self-start">已配音色</Tag>}
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
                        const meta = SHOT_STATUS[s.status] ?? { color: "default", text: s.status };
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
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-semibold text-[var(--muted-foreground,#a8a8a8)]">#{Number(s.idx) + 1}</span>
                                        {s.status === "voiced" && (
                                            <Button size="small" type="text" icon={<MessagesSquare className="h-3 w-3" />}
                                                loading={lipsyncingShots.has(s.id)}
                                                onClick={() => {
                                                    setLipsyncingShots((prev) => new Set(prev).add(s.id));
                                                    void triggerShotLipsync(s.id).finally(() => setLipsyncingShots((prev) => { const n = new Set(prev); n.delete(s.id); return n; }));
                                                }}>
                                                对口型
                                            </Button>
                                        )}
                                        {s.status === "rendered" && !s.voice_url && (
                                            <Button size="small" type="text" icon={<AudioLines className="h-3 w-3" />}
                                                loading={voicingShots.has(s.id)}
                                                onClick={() => {
                                                    setVoicingShots((prev) => new Set(prev).add(s.id));
                                                    void triggerShotVoice(s.id).finally(() => setVoicingShots((prev) => { const n = new Set(prev); n.delete(s.id); return n; }));
                                                }}>
                                                配音
                                            </Button>
                                        )}
                                        {!["rendering", "rendered", "voiced", "lipsynced", "done"].includes(s.status) && (
                                            <Button size="small" type="text" icon={<PlayCircle className="h-3 w-3" />}
                                                loading={renderingShots.has(s.id)}
                                                onClick={() => {
                                                    setRenderingShots((prev) => new Set(prev).add(s.id));
                                                    void triggerShotRender(s.id).finally(() => setRenderingShots((prev) => { const n = new Set(prev); n.delete(s.id); return n; }));
                                                }}>
                                                渲染
                                            </Button>
                                        )}
                                        <Tag color={meta.color} bordered={false}>{meta.text}</Tag>
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
                <Link to="/toiv/drama"><Button icon={<ArrowLeft className="h-3.5 w-3.5" />}>返回项目列表</Button></Link>
            </footer>
        <Drawer open={!!charDetail} onClose={() => setCharDetail(null)} width={480} title={charDetail?.char?.name || "角色"}>
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
                            {sheetsLoading ? <Spin /> : charDetail.sheets.length === 0 ? (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无设定卡" />
                            ) : charDetail.sheets.map((sh) => (
                                <div key={sh.style} className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] p-2">
                                    <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{sh.style}{sh.mtime ? ` · ${new Date(sh.mtime).toLocaleDateString("zh-CN")}` : ""}</span>
                                    {sh.sheet_url && <img src={sh.sheet_url} alt="" className="w-full rounded-lg" loading="lazy" />}
                                    {(sh.panel_urls ?? []).length > 0 && (
                                        <div className="grid grid-cols-3 gap-1">
                                            {sh.panel_urls!.slice(0, 9).map((p, i) => <img key={i} src={p} alt="" className="aspect-square w-full rounded-md object-cover" loading="lazy" />)}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </Drawer>
        </main>
    );
}
