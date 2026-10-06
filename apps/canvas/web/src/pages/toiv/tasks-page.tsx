import { App as AntApp, Badge, Button, Empty, Spin, Tag, Tooltip, Typography } from "antd";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { fetchAgentRuns, type ToivAgentRun } from "@/services/toiv/client";

const STATUS_META: Record<string, { color: string; text: string }> = {
    running: { color: "processing", text: "运行中" },
    awaiting_confirm: { color: "warning", text: "待确认" },
    done: { color: "success", text: "已完成" },
    completed: { color: "success", text: "已完成" },
    error: { color: "error", text: "失败" },
    canceled: { color: "default", text: "已取消" },
    pending: { color: "default", text: "排队中" },
};

function formatTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

export default function TasksPage() {
    const { message } = AntApp.useApp();
    const [runs, setRuns] = useState<ToivAgentRun[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try {
            setRuns(await fetchAgentRuns());
        } catch {
            setError(true);
            message.error("任务列表读取失败");
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => { void load(); }, [load]);

    return (
        <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <Typography.Title level={3} className="!mb-0">任务中心</Typography.Title>
                    <Typography.Text type="secondary">ToIV 智能体任务与运行记录（实时域：/api/agent-runs）</Typography.Text>
                </div>
                <div className="flex items-center gap-2">
                    <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()} loading={loading}>刷新</Button>
                    <Link to="/"><Button icon={<ArrowLeft className="h-3.5 w-3.5" />}>返回首页</Button></Link>
                </div>
            </header>

            {loading ? (
                <div className="flex min-h-64 items-center justify-center"><Spin /></div>
            ) : error ? (
                <Empty description="读取失败，请刷新重试" />
            ) : runs.length === 0 ? (
                <Empty description="还没有智能体任务；去智能体对话发第一条指令吧" />
            ) : (
                <ul className="flex flex-col gap-2">
                    {runs.map((run) => {
                        const meta = STATUS_META[run.status] ?? { color: "default", text: run.status };
                        const counts = run.task_counts;
                        return (
                            <li key={run.id} className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card,#181818)] px-4 py-3">
                                <Badge status={meta.color as never} text={<span className="text-sm">{meta.text}</span>} />
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
                                <Tag bordered={false}>{run.id.slice(0, 8)}</Tag>
                            </li>
                        );
                    })}
                </ul>
            )}
        </main>
    );
}
