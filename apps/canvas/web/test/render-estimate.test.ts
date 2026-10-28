import { describe, expect, test } from "bun:test";

import {
    canConfirmRenderEstimate,
    hasUnsavedShotChanges,
    renderEstimateError,
    renderEstimateErrorStage,
    renderEstimatePricing,
} from "../src/lib/render-estimate";
import type { ToivDramaShot } from "../src/services/toiv/client";
import { batchEstimate } from "./fixtures/render-estimate-fixtures";

describe("D0 金额与提交闸纯逻辑", () => {
    test("未定价永不显示 0/免费，unknowns 与预算上限原样保留", () => {
        const view = renderEstimatePricing(batchEstimate());
        expect(view.unpriced).toBe(true);
        expect(view.totalLabel).toBe("未配置费率");
        expect(view.note).toContain("不代表免费");
        expect(view.note).toContain("h3.rate");
        expect(view.totalLabel).not.toContain("0");
    });

    test("Decimal 金额字符串原样显示，不 parseFloat、不汇总", () => {
        const view = renderEstimatePricing(batchEstimate({
            pricing: { status: "estimated", currency: "CNY", total: "00012.340090", rate_source: "studio", unknowns: [] },
            budget: { status: "exceeded", limit: "10.000000", currency: "CNY" },
        }));
        expect(view.totalLabel).toBe("00012.340090 CNY");
        expect(view.budgetLabel).toContain("10.000000 CNY");
        expect(view.budgetExceeded).toBe(true);
    });

    test("估算中、失败、allowed=false 均禁止确认；未定价但 allowed 可确认", () => {
        const allowed = batchEstimate();
        expect(canConfirmRenderEstimate({ loading: true, error: null, estimate: allowed })).toBe(false);
        expect(canConfirmRenderEstimate({ loading: false, error: "失败", estimate: allowed })).toBe(false);
        expect(canConfirmRenderEstimate({ loading: false, error: null, estimate: { ...allowed, allowed: false } })).toBe(false);
        expect(canConfirmRenderEstimate({ loading: false, error: null, estimate: null })).toBe(false);
        expect(canConfirmRenderEstimate({ loading: false, error: null, estimate: allowed })).toBe(true);
    });

    test("错误 detail 保持字符串；409 可提取阶段入口", () => {
        const error = { response: { status: 409, data: { detail: "STAGE_REQUIRED: storyboard 未确认" } } };
        expect(renderEstimateError(error)).toBe("STAGE_REQUIRED: storyboard 未确认");
        expect(renderEstimateErrorStage(error)).toBe("storyboard");
        expect(renderEstimateError(new Error("network down"))).toBe("network down");
        expect(renderEstimateErrorStage(new Error("storyboard"))).toBeNull();
    });
});

describe("D0 单镜未保存编辑闸", () => {
    const shot: ToivDramaShot = {
        id: "s1", idx: 1, status: "draft", prompt: "旧提示", dialogue: "旧台词",
        duration_sec: 6, seam_to_next: "hardcut",
    };

    test("真实草稿差异、时长与衔接未保存时必须先保存", () => {
        expect(hasUnsavedShotChanges(shot, { field: "prompt", draft: "新提示" })).toBe(true);
        expect(hasUnsavedShotChanges(shot, { field: "dialogue", draft: "旧台词" })).toBe(false);
        expect(hasUnsavedShotChanges(shot, null, { s1: 8 })).toBe(true);
        expect(hasUnsavedShotChanges(shot, null, undefined, { s1: "continue" })).toBe(true);
    });

    test("无编辑或草稿与服务端相同不冒充脏数据", () => {
        expect(hasUnsavedShotChanges(shot, null, { s1: 6 }, { s1: "hardcut" })).toBe(false);
        expect(hasUnsavedShotChanges(shot, { field: "prompt", draft: "旧提示" })).toBe(false);
    });
});

test("D0 异步批量提交后，现有 runBatchRender 轮询 Job 再刷新 detail", async () => {
    const source = await Bun.file(new URL("../src/pages/toiv/drama-workspace.tsx", import.meta.url)).text();
    expect(source).toContain("const { job_id } = await triggerBatchRender(id, accelLevel, renderPipeline)");
    expect(source).toContain("await fetchJobById(job_id)");
});
