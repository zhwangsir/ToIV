import { describe, expect, test } from "bun:test";

import {
    formatSmokeBadgeLabel,
    isLikelySlowChainApp,
    smokeBadgeTone,
} from "@/services/toiv/smoke-badge";

describe("market smoke badge perception (timeout ≠ 不能跑)", () => {
    test("pass / fail keep success & failure semantics", () => {
        expect(formatSmokeBadgeLabel("pass")).toBe("烟测通过");
        expect(formatSmokeBadgeLabel("fail")).toBe("烟测失败");
        expect(formatSmokeBadgeLabel("error")).toBe("烟测失败");
        expect(smokeBadgeTone("pass")).toBe("success");
        expect(smokeBadgeTone("fail")).toBe("error");
    });

    test("timeout never shows English timeout or failure wording", () => {
        const label = formatSmokeBadgeLabel("timeout");
        expect(label).toBe("未验证（慢链）");
        expect(label).not.toMatch(/timeout/i);
        expect(label).not.toMatch(/失败|不可用|不能跑/);
        expect(smokeBadgeTone("timeout")).toBe("warning");
        expect(smokeBadgeTone("timeout")).not.toBe("error");
    });

    test("known slow engines → 慢链", () => {
        expect(isLikelySlowChainApp({ id: "utility-seedvr2-upscale" })).toBe(true);
        expect(formatSmokeBadgeLabel("timeout", { id: "rh-seedvr2-4k", name: "SeedVR2 超分" })).toBe("慢链");
        expect(formatSmokeBadgeLabel("timeout", { name: "FlashVSR 插帧" })).toBe("慢链");
        expect(formatSmokeBadgeLabel("timeout", { description: "RIFE frame interpolate" })).toBe("慢链");
        expect(formatSmokeBadgeLabel("TIMEOUT", { id: "wan2-i2v-local" })).toBe("慢链");
    });

    test("plain timeout without slow markers → 未验证（慢链）", () => {
        expect(isLikelySlowChainApp({ id: "avatar-talk", name: "数字人对话" })).toBe(false);
        expect(formatSmokeBadgeLabel("timeout", { id: "avatar-talk", name: "数字人对话" })).toBe("未验证（慢链）");
        expect(formatSmokeBadgeLabel("timed_out")).toBe("未验证（慢链）");
    });

    test("empty / running / unknown english statuses", () => {
        expect(formatSmokeBadgeLabel("")).toBeNull();
        expect(formatSmokeBadgeLabel(null)).toBeNull();
        expect(formatSmokeBadgeLabel("running")).toBe("烟测中");
        expect(smokeBadgeTone("running")).toBe("loading");
        expect(formatSmokeBadgeLabel("weird_status")).toBe("未验证");
        expect(formatSmokeBadgeLabel("未测过")).toBe("未测过");
    });
});

describe("market-page wires smoke badge mapper", () => {
    test("source imports helper and does not raw-render timeout", async () => {
        const src = await Bun.file(new URL("../src/pages/toiv/market-page.tsx", import.meta.url)).text();
        expect(src).toContain('from "@/services/toiv/smoke-badge"');
        expect(src).toContain("formatSmokeBadgeLabel");
        expect(src).toContain("smokeBadgeTone");
        // 旧实现：neutral + 原样 smoke_status（会露出英文 timeout）
        expect(src).not.toMatch(/label=\{app\.smoke_status\}/);
        expect(src).not.toMatch(/label=\{detail\.smoke_status\}/);
    });
});
