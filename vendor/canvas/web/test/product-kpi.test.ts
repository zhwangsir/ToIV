import { describe, expect, test } from "bun:test";

import { formatKpiValue, isKpiEmpty, KPI_METRIC_META, type ProductKpiSummary } from "../src/services/toiv/product-kpi";

describe("product-kpi F3", () => {
    test("null formats as 暂无数据 — never fake zero percent", () => {
        expect(formatKpiValue("percent", null)).toBe("暂无数据");
        expect(formatKpiValue("count", null)).toBe("暂无数据");
        expect(formatKpiValue("ms", null)).toBe("暂无数据");
        expect(formatKpiValue("percent", 0.666)).toBe("66.6%");
        expect(formatKpiValue("ms", 1500)).toBe("1.5s");
    });

    test("empty summary detection + four L6 metrics", () => {
        expect(KPI_METRIC_META.map((m) => m.id)).toEqual([
            "first_episode_assemble_rate",
            "no_free_canvas_completion_rate",
            "consistency_rework_count",
            "local_queue_wait_p50_ms",
        ]);
        const empty: ProductKpiSummary = {
            window_days: 30,
            sample_counts: {
                episode_assembled: 0,
                episode_assembled_ok: 0,
                path_touch: 0,
                consistency_rework: 0,
                queue_wait: 0,
                events_total: 0,
            },
            metrics: {
                first_episode_assemble_rate: null,
                no_free_canvas_completion_rate: null,
                consistency_rework_count: null,
                local_queue_wait_p50_ms: null,
            },
        };
        expect(isKpiEmpty(empty)).toBe(true);
        expect(isKpiEmpty({ ...empty, sample_counts: { ...empty.sample_counts, events_total: 2 } })).toBe(false);
    });
});
