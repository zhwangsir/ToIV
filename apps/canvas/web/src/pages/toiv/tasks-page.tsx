import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { Tooltip } from "@/components/ui/base/tooltip";
import { EmptyState } from "@/components/ui/product/empty-state";
import { fetchAgentRuns, type ToivAgentRun } from "@/services/toiv/client";

const STATUS_META: Record<string, { tone: "neutral" | "loading" | "success" | "error" | "warning"; text: string }> = {
    running: { tone: "loading", text: "运行中" },
    awaiting_confirm: { tone: "warning", text: "待确认" },
    done: { tone: "success", text: "已完成" },
    completed: { tone: "success", text: "已完成" },
    error: { tone: "error", text: "失败" },
    canceled: { tone: "neutral", text: "已取消" },
    pending: { tone: "neutral", text: "排队中" },
};

function formatTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

export default function TasksPage() {
    const [runs, setRuns] = useState<ToivAgentRun[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try {
            setRuns(await fetchAgentRuns());
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    return (
        <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">任务中心</h1>
                    <p className="text-xs leading-5 text-[var(--muted-foreground,#a8a8a8)]">ToIV 智能体任务与运行记录（实时域：/api/agent-runs）</p>
                </div>
                <div className="flex items-center gap-2">
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    <Link to="/"><ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
                </div>
            </header>

            {loading ? (
                <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
            ) : error ? (
                <EmptyState description="读取失败，请刷新重试" />
            ) : runs.length === 0 ? (
                <EmptyState description="还没有智能体任务；去智能体对话发第一条指令吧" />
            ) : (
                <ul className="flex flex-col gap-2">
                    {runs.map((run) => {
                        const meta = STATUS_META[run.status] ?? { tone: "neutral" as const, text: run.status };
                        const counts = run.task_counts;
                        return (
                            <li key={run.id} className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card,#181818)] px-4 py-3">
                                <StatusBadge tone={meta.tone} label={meta.text} />
                                <div className="min-w-0 flex-1">
                                    <Tooltip title={run.goal}>
                                        <p className="truncate text-sm font-medium">{run.goal || "(无目标摘要)"}</p>
                                    </Tooltip>
                                    <p className="mt-0.5 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                        {formatTime(run.created_at)}
                                        {run.level ? ` · ${run.level}` : ""}
                                        {counts && counts.total > 0 ? ` · 子任务 ${counts.done}/${counts.total}${counts.error ? ` · 失败 ${counts.error}` : ""}` : ""}
                                    </p>
                                </div>
                                <StatusBadge variant="filled" tone="neutral" label={run.id.slice(0, 8)} size="sm" />
                            </li>
                        );
                    })}
                </ul>
            )}
        </main>
    );
}
