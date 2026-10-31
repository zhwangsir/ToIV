/**
 * F3 / P4：北向 KPI（诚实空→有；null = 暂无样本，禁止伪造）。
 */
import { toivHttp } from "@/services/toiv/client";

export type KpiSurface = "drama_workspace" | "free_canvas" | "other";

export type KpiEventType =
    | "episode_assembled"
    | "path_touch"
    | "consistency_rework"
    | "queue_wait";

export type ProductKpiSummary = {
    window_days: number;
    sample_counts: {
        episode_assembled: number;
        episode_assembled_ok: number;
        path_touch: number;
        consistency_rework: number;
        queue_wait: number;
        events_total: number;
    };
    metrics: {
        first_episode_assemble_rate: number | null;
        no_free_canvas_completion_rate: number | null;
        consistency_rework_count: number | null;
        local_queue_wait_p50_ms: number | null;
    };
    notes?: Record<string, string>;
};

export const KPI_METRIC_META = [
    {
        id: "first_episode_assemble_rate" as const,
        label: "首集成片率",
        format: "percent" as const,
        hint: "成功合成 / 合成尝试；无尝试则为空",
    },
    {
        id: "no_free_canvas_completion_rate" as const,
        label: "不进自由画布完成率",
        format: "percent" as const,
        hint: "成片项目中从未进入自由画布的占比",
    },
    {
        id: "consistency_rework_count" as const,
        label: "一致性返工次数",
        format: "count" as const,
        hint: "窗口内 consistency_rework 事件绝对次数",
    },
    {
        id: "local_queue_wait_p50_ms" as const,
        label: "本地队列 P50 等待",
        format: "ms" as const,
        hint: "queue_wait 样本中位数（毫秒）",
    },
] as const;

export function formatKpiValue(
    format: "percent" | "count" | "ms",
    value: number | null | undefined,
): string {
    if (value == null || Number.isNaN(value)) return "暂无数据";
    if (format === "percent") return `${Math.round(value * 1000) / 10}%`;
    if (format === "ms") {
        if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
        return `${Math.round(value)}ms`;
    }
    return String(Math.round(value));
}

export function isKpiEmpty(summary: ProductKpiSummary | null | undefined): boolean {
    return !summary || (summary.sample_counts?.events_total ?? 0) === 0;
}

export async function fetchKpiSummary(days = 30): Promise<ProductKpiSummary> {
    const { data } = await toivHttp.get("/studio/kpi/summary", { params: { days } });
    return data as ProductKpiSummary;
}

export async function recordKpiEvent(input: {
    event_type: KpiEventType;
    project_id?: string;
    payload?: Record<string, unknown>;
}): Promise<void> {
    await toivHttp.post("/studio/kpi/events", {
        event_type: input.event_type,
        project_id: input.project_id ?? "",
        payload: input.payload ?? {},
    });
}

/** 短剧工作区触达（不进自由画布完成率分母/分子用） */
export async function touchDramaWorkspace(projectId: string): Promise<void> {
    try {
        await recordKpiEvent({
            event_type: "path_touch",
            project_id: projectId,
            payload: { surface: "drama_workspace" },
        });
    } catch {
        /* KPI 失败不挡创作 */
    }
}

export async function touchFreeCanvas(projectId = ""): Promise<void> {
    try {
        await recordKpiEvent({
            event_type: "path_touch",
            project_id: projectId,
            payload: { surface: "free_canvas" },
        });
    } catch {
        /* ignore */
    }
}

export async function recordConsistencyRework(projectId: string, reason?: string): Promise<void> {
    try {
        await recordKpiEvent({
            event_type: "consistency_rework",
            project_id: projectId,
            payload: reason ? { reason } : {},
        });
    } catch {
        /* ignore */
    }
}

export async function recordQueueWait(waitMs: number, projectId = ""): Promise<void> {
    if (!Number.isFinite(waitMs) || waitMs < 0) return;
    try {
        await recordKpiEvent({
            event_type: "queue_wait",
            project_id: projectId,
            payload: { wait_ms: waitMs },
        });
    } catch {
        /* ignore */
    }
}
