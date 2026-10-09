import { ArrowLeft, Clapperboard, Film, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { EmptyState } from "@/components/ui/product/empty-state";
import { fetchDramaProjects, type ToivDramaProject } from "@/services/toiv/client";
import { WorkspacePage } from "@/components/layout/workspace-page";

const STATUS_META: Record<string, { tone: "neutral" | "loading" | "success" | "error" | "warning"; text: string }> = {
    draft: { tone: "neutral", text: "草稿" },
    rendering: { tone: "loading", text: "渲染中" },
    voiced: { tone: "loading", text: "已配音" },
    lipsynced: { tone: "loading", text: "已对口型" },
    done: { tone: "success", text: "已完成" },
    error: { tone: "error", text: "失败" },
};

function fmt(v?: string): string {
    if (!v) return "—";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("zh-CN");
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
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted,rgba(255,255,255,0.08))]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-[var(--workspace-accent,#888)] transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            {p.next_step && <span className="text-[11px] text-muted-foreground">下一步:{p.next_step.label}(待办 {p.next_step.todo})</span>}
        </div>
    );
}

export default function DramaPage() {
    const [projects, setProjects] = useState<ToivDramaProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try { setProjects(await fetchDramaProjects()); }
        catch { setError(true); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { void load(); }, [load]);

    return (
        <WorkspacePage fluid className="toiv-drama-page">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">短剧工作台</h1>
                    <p className="text-xs leading-5 text-muted-foreground">ToIV 短剧项目与分镜管线（实时域：/api/studio/projects；详情在原工作台打开）</p>
                </div>
                <div className="flex items-center gap-2">
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    <Link to="/"><ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
                </div>
            </header>

            {loading ? <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
                : error ? <EmptyState description="读取失败，请刷新重试" />
                : projects.length === 0 ? <EmptyState description="还没有短剧项目；对智能体说「帮我把这个剧本做成短剧」即可开工" />
                : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
                        {projects.map((p) => {
                            const meta = STATUS_META[p.status] ?? { tone: "neutral" as const, text: p.status };
                            return (
                                <a key={p.id} href={`/toiv/drama/${p.id}`}
                                    className="group flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-[var(--workspace-accent,#555)]">
                                    <div className="flex items-center justify-between gap-2">
                                        <StatusBadge variant="filled" tone={meta.tone} label={meta.text} size="sm" />
                                        <span className="text-[11px] text-muted-foreground">{fmt(p.updated_at)}</span>
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
                                </a>
                            );
                        })}
                    </div>
                )}
        </div>
        </WorkspacePage>
    );
}
