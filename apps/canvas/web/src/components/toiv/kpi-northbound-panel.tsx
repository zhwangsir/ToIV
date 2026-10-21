/**
 * F3：北向 KPI 面板——真实样本或「暂无数据」，绝不造假。
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { BarChart3, RefreshCw } from "lucide-react";

import { ToolButton } from "@/components/ui/base/buttons";
import {
    KPI_METRIC_META,
    fetchKpiSummary,
    formatKpiValue,
    isKpiEmpty,
    type ProductKpiSummary,
} from "@/services/toiv/product-kpi";

type Props = {
    days?: number;
    compact?: boolean;
};

export function KpiNorthboundPanel({ days = 30, compact }: Props) {
    const [summary, setSummary] = useState<ProductKpiSummary | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setLoading(true);
        setErr(null);
        try {
            setSummary(await fetchKpiSummary(days));
        } catch (e) {
            setErr(e instanceof Error ? e.message : "指标加载失败");
            setSummary(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [days]);

    const empty = isKpiEmpty(summary);

    return (
        <section className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="flex flex-wrap items-center gap-2">
                <BarChart3 className="size-4 text-[var(--muted-foreground)]" />
                <h2 className="text-sm font-semibold text-foreground">北向学习指标</h2>
                <span className="text-xs text-[var(--muted-foreground)]">近 {days} 天 · 空=无样本</span>
                <span className="flex-1" />
                <ToolButton
                    size="xs"
                    variant="ghost"
                    icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />}
                    label="刷新"
                    onClick={() => void load()}
                />
                {!compact && (
                    <Link to="/toiv/kpi" className="text-xs text-[var(--workspace-accent)] underline-offset-2 hover:underline">
                        打开看板
                    </Link>
                )}
            </div>
            {err && <p className="text-xs text-[var(--danger)]">{err}</p>}
            {empty && !err && (
                <p className="rounded-lg border border-dashed border-[var(--border)] p-3 text-xs text-[var(--muted-foreground)]">
                    暂无埋点样本。在短剧工作区合成成片、触达路径后这里会填入真实比率——不会显示虚构的 0% 成功。
                </p>
            )}
            <div className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"}`}>
                {KPI_METRIC_META.map((m) => {
                    const raw = summary?.metrics?.[m.id] ?? null;
                    return (
                        <div key={m.id} className="rounded-xl border border-[var(--border)] bg-background p-3">
                            <p className="text-[11px] text-[var(--muted-foreground)]">{m.label}</p>
                            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                                {loading ? "…" : formatKpiValue(m.format, raw)}
                            </p>
                            <p className="mt-1 text-[10px] leading-snug text-[var(--muted-foreground)]">{m.hint}</p>
                        </div>
                    );
                })}
            </div>
            {summary && !empty && (
                <p className="text-[10px] text-[var(--muted-foreground)]">
                    样本：合成尝试 {summary.sample_counts.episode_assembled} · 成功{" "}
                    {summary.sample_counts.episode_assembled_ok} · 路径触达 {summary.sample_counts.path_touch} · 返工{" "}
                    {summary.sample_counts.consistency_rework} · 队列 {summary.sample_counts.queue_wait}
                </p>
            )}
        </section>
    );
}
