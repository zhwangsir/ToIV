import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    OFF_ACCEL_TIER,
    formatAccelTierLabel,
    formatAccelTierNote,
    type ToivAccelTier,
} from "../src/services/toiv/client";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const BALANCED: ToivAccelTier = {
    level: "balanced",
    label: "甜点位",
    speedup: 2.94,
    ssim: 0.8194,
    recommended: true,
    source: "measured",
    note: "实测去噪 175s vs native 515s = 2.94x",
};

const WAN_TURBO: ToivAccelTier = {
    level: "turbo",
    label: "草稿极速(4 步)",
    speedup: null,
    ssim: null,
    recommended: true,
    source: "reference",
    note: "Seko 双 LoRA 蒸馏,4 步采样",
};

describe("任务 #24 — 加速档 label/note 格式化", () => {
    test("off 档 label 固定为「满血（默认）」", () => {
        expect(formatAccelTierLabel(OFF_ACCEL_TIER)).toBe("满血（默认）");
    });

    test("实测档 label 形如「甜点位 · 2.94x · SSIM 0.82」", () => {
        expect(formatAccelTierLabel(BALANCED)).toBe("甜点位 · 2.94x · SSIM 0.82");
    });

    test("无实测倍率/SSIM 的参考档 label 只显名称", () => {
        expect(formatAccelTierLabel(WAN_TURBO)).toBe("草稿极速(4 步)");
    });

    test("reference 档说明带「参考值」字样", () => {
        expect(formatAccelTierNote(WAN_TURBO)).toContain("参考值");
        expect(formatAccelTierNote(WAN_TURBO)).toContain("Seko 双 LoRA");
    });

    test("measured 档说明不加「参考值」前缀", () => {
        const note = formatAccelTierNote(BALANCED);
        expect(note).not.toContain("参考值");
        expect(note).toContain("2.94x");
    });
});

describe("任务 #24 — client.ts 渲染请求带 accel + tiers 端点", () => {
    const client = read("src/services/toiv/client.ts");

    test("fetchAccelTiers 打 /acceleration/tiers", () => {
        expect(client).toContain('toivHttp.get("/acceleration/tiers")');
    });

    test("renderShotAsync / renderShotStrict 支持 accel 选项并注入请求体", () => {
        expect(client).toContain("accel?: string");
        expect(client).toContain('payload.accel = opts.accel');
    });

    test("triggerBatchRender 透传 accel 到 project render 请求体", () => {
        // 渲染管线期起签名扩为 (pid, accel?, pipeline)，body 由三元改逐项组装；
        // accel 语义不变：非 off 才注入请求体。
        expect(client).toMatch(/triggerBatchRender\(\s*pid: string,\s*accel\?: string,/);
        expect(client).toContain('if (accel && accel !== "off") body.accel = accel;');
    });
});

describe("任务 #24 — drama-workspace 加速档 Select 接线", () => {
    const page = read("src/pages/toiv/drama-workspace.tsx");

    test("有「加速档」Select 且默认满血 off", () => {
        expect(page).toContain("加速档");
        expect(page).toContain('useState<string>("off")');
        expect(page).toContain("fetchAccelTiers");
    });

    test("选项 label 走 formatAccelTierLabel,说明走 formatAccelTierNote", () => {
        expect(page).toContain("formatAccelTierLabel(t)");
        expect(page).toContain("formatAccelTierNote(selectedAccelTier)");
    });

    test("单镜/整批渲染把 accelLevel 传进请求", () => {
        // R11 后调用为多行对象并带 renderPipeline 等扩展参数;C1b 后 runShotRender 带 opts,
        // accel 默认档仍是 accelLevel(显式 opts.accel 仅配方 render_params 覆盖时生效)。
        expect(page).toContain("num_candidates: opts.num_candidates ?? 2");
        expect(page).toContain("accel: opts.accel ?? accelLevel");
        expect(page).toContain("triggerBatchRender(id, accelLevel");
    });
});
