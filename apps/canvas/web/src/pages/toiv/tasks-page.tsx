import { ArrowLeft, ListChecks, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { Tooltip } from "@/components/ui/base/tooltip";
import { EmptyState } from "@/components/ui/product/empty-state";
import { cancelJob, fetchJobs, type ToivJob } from "@/services/toiv/client";

const STATUS_META: Record<string, { tone: "neutral" | "loading" | "success" | "error" | "warning"; text: string }> = {
    queued: { tone: "neutral", text: "排队中" },
    held: { tone: "warning", text: "等待资源" },
    running: { tone: "loading", text: "运行中" },
    done: { tone: "success", text: "已完成" },
    error: { tone: "error", text: "失败" },
    canceled: { tone: "neutral", text: "已取消" },
};

const CANCELABLE = new Set(["queued", "held", "running"]);

function formatTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

function promptSummary(prompt?: string): string {
    const text = (prompt || "").trim();
    if (!text) return "(无提示摘要)";
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function detailLine(job: ToivJob): string {
    const parts: string[] = [formatTime(job.created_at)];
    if (job.kind) parts.push(job.kind);
    const reason = (job.status === "held" ? job.hold_reason : job.error)?.trim();
    if (reason) parts.push(reason.length > 48 ? `${reason.slice(0, 48)}…` : reason);
    return parts.join(" · ");
}

export default function TasksPage() {
    const [jobs, setJobs] = useState<ToivJob[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [cancelingId, setCancelingId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            setJobs(await fetchJobs());
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const onCancel = async (jobId: string) => {
        setCancelingId(jobId);
        try {
            const ok = await cancelJob(jobId);
            if (ok) await load();
        } finally {
            setCancelingId(null);
        }
    };

    return (
        <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">任务中心</h1>
                    <p className="text-xs leading-5 text-muted-foreground">ToIV 生成作业（/api/jobs）。画布进行中任务见顶栏 chip；完整画布历史见「任务」页。</p>
                </div>
                <div className="flex items-center gap-2">
                    <Link to="/tasks"><ToolButton variant="default" icon={<ListChecks />} label="画布任务" /></Link>
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    <Link to="/"><ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
                </div>
            </header>

            {loading ? (
                <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
            ) : error ? (
                <EmptyState description="读取失败，请刷新重试" />
            ) : jobs.length === 0 ? (
                <EmptyState description="还没有生成作业" />
            ) : (
                <ul className="flex flex-col gap-2">
                    {jobs.map((job) => {
                        const meta = STATUS_META[job.status] ?? { tone: "neutral" as const, text: job.status };
                        const canCancel = CANCELABLE.has(job.status);
                        return (
                            <li key={job.id} className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
                                <StatusBadge tone={meta.tone} label={meta.text} />
                                <div className="min-w-0 flex-1">
                                    <Tooltip title={job.prompt || ""}>
                                        <p className="truncate text-sm font-medium">{promptSummary(job.prompt)}</p>
                                    </Tooltip>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{detailLine(job)}</p>
                                </div>
                                {canCancel ? (
                                    <ToolButton
                                        variant="ghost"
                                        size="sm"
                                        tone="danger"
                                        icon={<X />}
                                        label="取消"
                                        loading={cancelingId === job.id}
                                        onClick={() => void onCancel(job.id)}
                                    />
                                ) : null}
                                <StatusBadge variant="filled" tone="neutral" label={job.id.slice(0, 8)} size="sm" />
                            </li>
                        );
                    })}
                </ul>
            )}
        </main>
    );
}
