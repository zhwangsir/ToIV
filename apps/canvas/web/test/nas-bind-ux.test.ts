import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    NAS_BIND_STAGE_ORDER,
    basenameFromRel,
    isNasSwapPending,
    nasBindProgressStatus,
    nasBindStageLabel,
    nasBindStepState,
} from "@/lib/nas-bind-ux";

describe("nas bind swap + progress UX", () => {
    test("stage order matches backend validate → refresh/bind → done", () => {
        expect([...NAS_BIND_STAGE_ORDER]).toEqual(["validate", "refresh/bind", "done"]);
        expect(nasBindStageLabel("validate")).toBe("校验路径");
        expect(nasBindStageLabel("refresh/bind")).toBe("写入绑定并刷新");
        expect(nasBindStageLabel("done")).toBe("完成");
        expect(nasBindStageLabel("error")).toBe("失败");
    });

    test("basename and swap-pending detection", () => {
        expect(basenameFromRel("checkpoints/foo.safetensors")).toBe("foo.safetensors");
        expect(basenameFromRel("h3\\diffusion_models\\a.safetensors")).toBe("a.safetensors");
        expect(isNasSwapPending("a/x.safetensors", "a/x.safetensors")).toBe(false);
        expect(isNasSwapPending("a/new.safetensors", "a/old.safetensors")).toBe(true);
        expect(isNasSwapPending("a/new.safetensors", undefined)).toBe(false);
    });

    test("progress status + step states", () => {
        expect(nasBindProgressStatus({ stage: "validate", status: "running", percent: 35 })).toBe("active");
        expect(nasBindProgressStatus({ stage: "done", status: "done", percent: 100 })).toBe("success");
        expect(nasBindProgressStatus({ stage: "refresh/bind", status: "error", percent: 70 })).toBe("exception");

        expect(nasBindStepState("validate", { stage: "refresh/bind", status: "running" })).toBe("done");
        expect(nasBindStepState("refresh/bind", { stage: "refresh/bind", status: "running" })).toBe("current");
        expect(nasBindStepState("done", { stage: "refresh/bind", status: "running" })).toBe("pending");
        expect(nasBindStepState("done", { stage: "done", status: "done" })).toBe("done");
        expect(nasBindStepState("refresh/bind", { stage: "refresh/bind", status: "error" })).toBe("error");
    });

    test("local-compute-pane wires swap strip + live poll progress", () => {
        const pane = readFileSync(resolve(import.meta.dir, "../src/pages/settings/local-compute-pane.tsx"), "utf8");
        const css = readFileSync(resolve(import.meta.dir, "../src/pages/settings/local-compute-pane.css"), "utf8");
        const api = readFileSync(resolve(import.meta.dir, "../src/services/api/nas-models.ts"), "utf8");

        expect(pane).toContain("NasBindProgressBlock");
        expect(pane).toContain("nas-image-bind-progress");
        expect(pane).toContain("nas-video-bind-progress");
        expect(pane).toContain("nas-bind-progress");
        expect(pane).toContain("isNasSwapPending");
        expect(pane).toContain("onProgress");
        expect(pane).toContain('data-testid={`${testId}-swap`}');
        expect(pane).toContain("nasBindStageLabel");
        // 分类分组仍用既有 groupByPurpose，本刀不重做
        expect(pane).toContain("groupByPurpose");

        expect(css).toContain(".nas-swap-strip");
        expect(css).toContain("nas-swap-pulse");
        expect(css).toContain("prefers-reduced-motion");
        expect(css).toContain(".nas-bind-steps");

        expect(api).toContain("onProgress?: (job: NasBindJob) => void");
        expect(api).toContain("opts?.onProgress?.(job)");
    });
});
