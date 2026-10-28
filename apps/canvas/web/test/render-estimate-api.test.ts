import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
    estimateBatchRender,
    estimateShotRender,
    fetchJobById,
    triggerBatchRender,
    toivHttp,
} from "../src/services/toiv/client";
import { batchEstimate, shotEstimate } from "./fixtures/render-estimate-fixtures";

type Captured = { method: string; path: string; body: unknown };
const captured: Captured[] = [];

const server = Bun.serve({
    port: 0,
    async fetch(request) {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null);
        captured.push({ method: request.method, path: url.pathname, body });
        if (url.pathname === "/api/studio/projects/p%201/render-estimate" && request.method === "POST") {
            return Response.json(batchEstimate({ project_id: "p 1" }));
        }
        if (url.pathname === "/api/studio/projects/p1/render-estimate" && request.method === "POST") {
            return Response.json(batchEstimate());
        }
        if (url.pathname === "/api/studio/projects/p1/render" && request.method === "POST") {
            return Response.json({ job_id: "job-live", status: "queued", project_id: "p1" }, { status: 202 });
        }
        if (url.pathname === "/api/jobs/lookup" && request.method === "GET") {
            return Response.json({ id: "job-live", kind: "studio_batch_render", status: "done", created_at: "2026-10-28T00:00:00" });
        }
        if (url.pathname === "/api/studio/shots/s%2F1/render-estimate" && request.method === "POST") {
            return Response.json(shotEstimate({ shot_id: "s/1" }));
        }
        if (url.pathname === "/api/studio/shots/s1/render-estimate" && request.method === "POST") {
            return Response.json(shotEstimate({ shot_id: "s1" }));
        }
        if (url.pathname === "/api/studio/shots/conflict/render-estimate") {
            return Response.json({ detail: "STAGE_REQUIRED: storyboard 未确认" }, { status: 409 });
        }
        if (url.pathname === "/api/studio/shots/keyframe/render" && request.method === "POST") {
            return Response.json({
                detail: { code: "KEYFRAME_REQUIRED", message: "请先采用关键帧", hint: "采用一帧后再试" },
            }, { status: 422 });
        }
        return new Response("not found", { status: 404 });
    },
});

const originalBaseURL = toivHttp.defaults.baseURL;
beforeAll(() => {
    toivHttp.defaults.baseURL = `${server.url.origin}/api`;
    captured.length = 0;
});
afterAll(() => {
    toivHttp.defaults.baseURL = originalBaseURL;
    server.stop(true);
});

describe("D0 render-estimate 真实 HTTP 契约", () => {
    test("整批 POST path/body 原样，返回 Decimal 字符串不被数值化", async () => {
        const result = await estimateBatchRender("p1", { accel: "off", pipeline: "ref2va" });
        expect(captured.at(-1)).toEqual({
            method: "POST",
            path: "/api/studio/projects/p1/render-estimate",
            body: { accel: "off", pipeline: "ref2va" },
        });
        expect(result.schema).toBe("toiv_render_estimate_v1");
        expect(result.pricing.total).toBeNull();
    });

    test("整批可带 wait，项目 id 转义", async () => {
        await estimateBatchRender("p 1", { accel: "turbo", pipeline: "c", wait: false });
        expect(captured.at(-1)).toMatchObject({
            path: "/api/studio/projects/p%201/render-estimate",
            body: { accel: "turbo", pipeline: "c", wait: false },
        });
    });

    test("单镜使用现有 RenderShotBody 的真实输入与默认值", async () => {
        await estimateShotRender("s1", {
            num_candidates: 4,
            accel: "turbo",
            pipeline: "c_hybrid",
            force_direct: true,
            auto_pick: false,
            seed: 42,
            ref_images: ["/character.png"],
            scene_images: ["/scene.png"],
            ref_style: "anime",
            video_model: "h3-custom",
        });
        expect(captured.at(-1)).toEqual({
            method: "POST",
            path: "/api/studio/shots/s1/render-estimate",
            body: {
                num_candidates: 4,
                wait: false,
                pipeline: "c_hybrid",
                accel: "turbo",
                force_direct: true,
                auto_pick: false,
                seed: 42,
                ref_images: ["/character.png"],
                scene_images: ["/scene.png"],
                ref_style: "anime",
                video_model: "h3-custom",
            },
        });
    });

    test("单镜 off 不发 accel，shot id 转义，409 detail 保留字符串", async () => {
        await estimateShotRender("s/1", { accel: "off" });
        expect(captured.at(-1)).toMatchObject({
            path: "/api/studio/shots/s%2F1/render-estimate",
            body: { num_candidates: 2, wait: false, pipeline: "ref2va" },
        });
        let thrown: unknown;
        try {
            await estimateShotRender("conflict");
        } catch (error) {
            thrown = error;
        }
        const response = (thrown as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
        expect(response?.status).toBe(409);
        expect(response?.data?.detail).toBe("STAGE_REQUIRED: storyboard 未确认");
    });

    test("真实批量提交 wait=false 返回 job_id，作业查询走 lookup", async () => {
        const ack = await triggerBatchRender("p1", "off", "ref2va");
        expect(ack).toMatchObject({ job_id: "job-live", status: "queued", project_id: "p1" });
        expect(captured.at(-1)).toMatchObject({
            method: "POST",
            path: "/api/studio/projects/p1/render",
            body: { wait: false },
        });
        const job = await fetchJobById("job-live");
        expect(job).toMatchObject({ id: "job-live", status: "done" });
        expect(captured.at(-1)).toMatchObject({ method: "GET", path: "/api/jobs/lookup" });
    });

    test("单镜结构化 KEYFRAME_REQUIRED 不变成 [object Object]", async () => {
        const { renderShotAsync } = await import("../src/services/toiv/client");
        await expect(renderShotAsync("keyframe")).rejects.toThrow("请先采用关键帧");
        await expect(renderShotAsync("keyframe")).rejects.toThrow("KEYFRAME_REQUIRED");
    });
});
