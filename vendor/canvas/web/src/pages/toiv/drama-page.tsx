import { ArrowLeft, Clapperboard, Film, Images, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { ToivEmptyState } from "@/components/toiv/toiv-empty-state";
import { ToivSkeletonGrid } from "@/components/toiv/toiv-skeleton";
import { formatDateTime } from "@/lib/time-format";
import { createStudioProject, fetchDramaProjects, seedRainNightSample, type ToivDramaProject } from "@/services/toiv/client";
import { FromImageDialog } from "./from-image-dialog";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { KpiNorthboundPanel } from "@/components/toiv/kpi-northbound-panel";
import "@/styles/toiv-freezone-desk.css";

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

const PHASES = ["剧本", "资产", "分镜", "成片"] as const;
function phaseDoneCount(status: string): number {
    switch (status) {
        case "draft":
            return 1;
        case "ready":
        case "storyboard":
            return 2;
        case "queued":
        case "rendering":
            return 3;
        case "rendered":
        case "voiced":
        case "lipsynced":
        case "done":
            return 4;
        case "error":
        case "failed":
            return 2;
        default:
            return 1;
    }
}

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
        <WorkspacePage fluid className="toiv-drama-page fz-desk">
            <div className="fz-desk-page mx-auto flex w-full max-w-6xl flex-col gap-3">
            <header className="fz-desk-toolbar">
                <h1>短剧项目</h1>
                <p>密网 · 剧本→资产→分镜→成片</p>
                <div className="fz-desk-actions">
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

            {loading ? (
                <ToivSkeletonGrid count={8} className="fz-dense-grid" />
            ) : error ? (
                <ToivEmptyState
                    className="fz-panel fz-auth-gap"
                    icon={RefreshCw}
                    title="短剧列表暂不可用"
                    description={actionNote || "可能是会话失效或接口未就绪（含 401）。请刷新重试；不会显示占位假项目。"}
                    action={<button type="button" className="toiv-empty-cta" onClick={() => void load()}>重试加载</button>}
                />
            ) : projects.length === 0 ? (
                <ToivEmptyState
                    className="fz-panel"
                    icon={Clapperboard}
                    title="还没有短剧项目"
                    description="新建空白短剧，或打开雨夜示例；也可去创作台用对话开场。"
                    action={
                        <div className="fz-pill-row" style={{ justifyContent: "center" }}>
                            <ToolButton variant="default" active icon={<Plus className="size-4" />} label="新建短剧" onClick={() => void createBlank()} loading={creating} />
                            <ToolButton variant="default" icon={<Clapperboard className="size-4" />} label="雨夜示例" onClick={() => void openRainNight()} />
                            <Link to="/create"><ToolButton variant="default" label="去创作" /></Link>
                        </div>
                    }
                />
            ) : (
                <div className="fz-list" aria-label="短剧项目列表">
                    {projects.map((proj) => {
                        const meta = STATUS_META[proj.status] ?? { tone: "neutral" as const, text: proj.status };
                        return (
                            <Link key={proj.id} to={`/create?project=${proj.id}`} className="fz-list-row group">
                                <div className="fz-list-row-main">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <StatusBadge variant="filled" tone={meta.tone} label={meta.text} size="sm" />
                                        <p className="fz-card-title" title={proj.title || proj.premise}>
                                            {proj.title || proj.premise?.slice(0, 24) || "未命名项目"}
                                        </p>
                                    </div>
                                    {proj.premise ? <p className="fz-card-meta line-clamp-1">{proj.premise}</p> : null}
                                    <div className="fz-phase-row" aria-label="阶段">
                                        {PHASES.map((label, idx) => (
                                            <span key={label} className={`fz-phase-pip${idx < phaseDoneCount(proj.status) ? " is-done" : ""}`}>{label}</span>
                                        ))}
                                    </div>
                                    {proj.pipeline ? <ShotProgress p={proj.pipeline} /> : null}
                                </div>
                                <div className="fz-list-row-meta">
                                    <span>{formatDateTime(proj.updated_at)}</span>
                                    <span className="flex items-center gap-1"><Film className="h-3 w-3" />{proj.width}×{proj.height}</span>
                                    {proj.final_url
                                        ? <StatusBadge variant="filled" tone="success" label="有成片" size="sm" />
                                        : <span className="flex items-center gap-1"><Clapperboard className="h-3 w-3" />打开</span>}
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
