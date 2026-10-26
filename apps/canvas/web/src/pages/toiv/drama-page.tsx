import { ArrowLeft, Clapperboard, Film, Images, Loader2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { EmptyState } from "@/components/ui/product/empty-state";
import { formatDateTime } from "@/lib/time-format";
import { createStudioProject, fetchDramaProjects, seedRainNightSample, type ToivDramaProject } from "@/services/toiv/client";
import { FromImageDialog } from "./from-image-dialog";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { KpiNorthboundPanel } from "@/components/toiv/kpi-northbound-panel";

const STATUS_META: Record<string, { tone: "neutral" | "loading" | "success" | "error" | "warning"; text: string }> = {
    draft: { tone: "neutral", text: "草稿" },
    ready: { tone: "success", text: "已就绪" },
    queued: { tone: "warning", text: "排队中" },
    rendering: { tone: "loading", text: "生成中" },
    rendered: { tone: "success", text: "已出视频" },
    voiced: { tone: "success", text: "已配音" },
    lipsynced: { tone: "success", text: "已对口型" },
    done: { tone: "success", text: "已完成" },
    error: { tone: "error", text: "失败" },
    failed: { tone: "error", text: "失败" },
    storyboard: { tone: "warning", text: "分镜中" },
};

function ShotProgress({ p }: { p: NonNullable<ToivDramaProject["pipeline"]> }) {
    const total = p.total_shots || 0;
    const done = (p.by_status?.done ?? 0) + (p.by_status?.lipsynced ?? 0);
    const pct = total ? Math.round((done / total) * 100) : 0;
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{total} 个分镜 · {done}/{total} 完成</span>
                <span>{Object.entries(p.by_status ?? {}).map(([k, n]) => `${STATUS_META[k]?.text ?? k}${n}`).join(" ")}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-[var(--workspace-accent)] transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            {p.next_step && <span className="text-[11px] text-muted-foreground">下一步:{p.next_step.label}(待办 {p.next_step.todo})</span>}
        </div>
    );
}

export default function DramaPage() {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const [projects, setProjects] = useState<ToivDramaProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [fromImageOpen, setFromImageOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [actionNote, setActionNote] = useState<string | null>(null);
    const autoNewOnce = useRef(false);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try { setProjects(await fetchDramaProjects()); }
        catch { setError(true); }
        finally { setLoading(false); }
    }, []);

    const createBlank = useCallback(async () => {
        if (creating) return;
        setCreating(true);
        setActionNote(null);
        try {
            const project = await createStudioProject({ title: "未命名短剧" });
            navigate(`/create?project=${encodeURIComponent(project.id)}&section=script`);
        } catch (e) {
            setActionNote(e instanceof Error ? e.message : "新建短剧失败");
        } finally {
            setCreating(false);
        }
    }, [creating, navigate]);

    const openRainNight = useCallback(async () => {
        setActionNote(null);
        try {
            const sample = await seedRainNightSample();
            navigate(`/create?project=${encodeURIComponent(sample.id)}&section=script`);
        } catch (e) {
            setActionNote(e instanceof Error ? e.message : "打开雨夜示例失败");
        }
    }, [navigate]);

    useEffect(() => { void load(); }, [load]);

    // 侧栏/命令面板「新建短剧」→ /toiv/drama?new=1
    useEffect(() => {
        if (searchParams.get("new") !== "1" || autoNewOnce.current) return;
        autoNewOnce.current = true;
        const next = new URLSearchParams(searchParams);
        next.delete("new");
        setSearchParams(next, { replace: true });
        void createBlank();
    }, [searchParams, setSearchParams, createBlank]);

    return (
        <WorkspacePage fluid className="toiv-drama-page">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">短剧项目</h1>
                    <p className="text-xs leading-5 text-muted-foreground">剧本 → 资产 → 分镜 → 镜头 → 时间线 → 成片,打开项目进六段工作区</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <ToolButton variant="default" active icon={<Plus className="size-4" />} label="新建短剧" onClick={() => void createBlank()} loading={creating} />
                    <ToolButton variant="default" icon={<Clapperboard className="size-4" />} label="雨夜示例" onClick={() => void openRainNight()} />
                    <ToolButton variant="default" icon={<Images className="size-4" />} label="从图片创建" onClick={() => setFromImageOpen(true)} />
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    <Link to="/"><ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
                </div>
            </header>

            <KpiNorthboundPanel days={30} compact />

            {actionNote && projects.length > 0 ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{actionNote}</p>
            ) : null}

            {fromImageOpen && (
                <FromImageDialog
                    open
                    onClose={() => setFromImageOpen(false)}
                    onProjectCreated={(pid) => { setFromImageOpen(false); void load(); navigate(`/create?project=${pid}`); }}
                />
            )}

            {loading ? <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
                : error ? <EmptyState description="读取失败，请刷新重试" />
                : projects.length === 0 ? (
                    <EmptyState
                        description={actionNote || "还没有短剧项目。可新建空白短剧，或打开雨夜示例对照学习；也可对智能体描述需求。"}
                        action={
                            <div className="flex flex-wrap items-center justify-center gap-2">
                                <ToolButton variant="default" active icon={<Plus className="size-4" />} label="新建短剧" onClick={() => void createBlank()} loading={creating} />
                                <ToolButton variant="default" icon={<Clapperboard className="size-4" />} label="打开雨夜示例" onClick={() => void openRainNight()} />
                                <Link to="/toiv/agent"><ToolButton variant="default" label="去智能体对话" /></Link>
                            </div>
                        }
                    />
                )
                : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
                        {projects.map((p) => {
                            const meta = STATUS_META[p.status] ?? { tone: "neutral" as const, text: p.status };
                            return (
                                // S4/W1.2:项目卡默认进 v2 工作区(经典详情仍有入口)
                                <Link key={p.id} to={`/create?project=${p.id}`}
                                    className="group flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-[var(--workspace-accent)]">
                                    <div className="flex items-center justify-between gap-2">
                                        <StatusBadge variant="filled" tone={meta.tone} label={meta.text} size="sm" />
                                        <span className="text-[11px] text-muted-foreground">{formatDateTime(p.updated_at)}</span>
                                    </div>
                                    <p className="line-clamp-1 text-sm font-medium" title={p.title || p.premise}>
                                        {p.title || p.premise?.slice(0, 24) || "未命名项目"}
                                    </p>
                                    <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">{p.premise}</p>
                                    {p.pipeline && <ShotProgress p={p.pipeline} />}
                                    <div className="mt-auto flex items-center justify-between pt-1">
                                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Film className="h-3 w-3" />{p.width}×{p.height} · {p.render_mode_default ?? "video"}</span>
                                        {p.final_url
                                            ? <StatusBadge variant="filled" tone="success" label="有成片" size="sm" />
                                            : <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Clapperboard className="h-3 w-3" />打开工作台 →</span>}
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}
        </div>
        </WorkspacePage>
    );
}
