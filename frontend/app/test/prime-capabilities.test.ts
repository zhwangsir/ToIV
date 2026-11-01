import { afterEach, expect, test } from "bun:test";
import {
    defaultDurationValue, defaultModelValue, defaultSizeValue, fetchToolCapabilities,
} from "../src/toiv/adapters/capabilities";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const RAW = {
    schema_version: 1,
    tools: {
        image: {
            id: "image",
            label: "文生图",
            engine_id: "txt2img",
            route: "/api/generate/txt2img",
            available: true,
            unavailable_reason: null,
            model_param: "ckpt_name",
            models: [
                { value: "", label: "平台默认底模", default: true, nsfw: false, desc: "" },
                { value: "sdxl.safetensors", label: "SDXL", default: false, nsfw: true, desc: "写实" },
            ],
            sizes: [
                { value: "1:1", label: "1:1 方形", width: 1024, height: 1024, available: true, reason: null },
                { value: "2:1", label: "2:1 宽幅", width: 1024, height: 512, available: true, reason: null },
            ],
            durations: [],
            limits: { prompt_max_chars: 2000 },
            affects: ["工具中心 · 文生图"],
        },
        video: {
            id: "video",
            label: "文生视频",
            engine_id: "h3-t2v",
            route: "/api/h3/t2v",
            available: true,
            unavailable_reason: null,
            model_param: null,
            models: [],
            sizes: [
                { value: "16:9", label: "16:9 横屏", width: 1344, height: 768, available: true, reason: null },
                { value: "2:1", label: "2:1 宽幅", width: 1344, height: 672, available: false, reason: "超出引擎宽高比范围 9:16–16:9" },
            ],
            durations: [
                { value: "5", label: "5 秒", seconds: 5, default: true, available: true, reason: null },
                { value: "6", label: "6 秒", seconds: 6, default: false, available: true, reason: null },
            ],
            limits: {},
            affects: ["工具中心 · 文生视频"],
        },
    },
    slots: [],
    issues: [],
};

test("capabilities normalise the backend single source", async () => {
    globalThis.fetch = (async () => json(RAW)) as typeof fetch;
    const caps = await fetchToolCapabilities();

    expect(caps.tools.image.engineId).toBe("txt2img");
    expect(caps.tools.image.modelParam).toBe("ckpt_name");
    expect(caps.tools.image.models[1]).toMatchObject({ value: "sdxl.safetensors", nsfw: true, desc: "写实" });
    expect(caps.tools.video.durations.map((item) => item.seconds)).toEqual([5, 6]);
    expect(caps.tools.video.sizes[1]).toMatchObject({ available: false, width: 1344, height: 672 });
    expect(caps.tools.video.sizes[1].reason).toContain("9:16");
});

test("capabilities keep an explicit unavailable engine instead of fabricating options", async () => {
    globalThis.fetch = (async () => json({
        tools: {
            image: { ...RAW.tools.image, available: false, unavailable_reason: "worker 不可达", sizes: [] },
        },
        slots: [],
        issues: [{ id: "tool-image-unavailable", title: "文生图暂不可用", reason: "worker 不可达", affects: ["工具中心 · 文生图"] }],
    })) as typeof fetch;
    const caps = await fetchToolCapabilities();

    expect(caps.tools.image.available).toBe(false);
    expect(caps.tools.image.unavailableReason).toBe("worker 不可达");
    expect(caps.tools.image.sizes).toEqual([]);
    expect(caps.tools.video.available).toBe(false);
    expect(caps.issues[0].affects).toEqual(["工具中心 · 文生图"]);
});

test("capability fetch failures surface the backend detail", async () => {
    globalThis.fetch = (async () => json({ detail: "引擎注册表不可用" }, 503)) as typeof fetch;
    await expect(fetchToolCapabilities()).rejects.toThrow("引擎注册表不可用");
});

test("default pickers prefer available engine options", () => {
    const caps = {
        tools: {
            image: {
                ...RAW.tools.image,
                sizes: [
                    { value: "16:9", label: "16:9 横屏", width: 1024, height: 576, available: false, reason: "超限" },
                    { value: "1:1", label: "1:1 方形", width: 1024, height: 1024, available: true, reason: null },
                ],
            },
            video: RAW.tools.video,
        },
    } as unknown as Awaited<ReturnType<typeof fetchToolCapabilities>>;

    expect(defaultSizeValue(caps.tools.image, "16:9")).toBe("1:1");
    expect(defaultSizeValue(caps.tools.video, "16:9")).toBe("16:9");
    expect(defaultDurationValue(caps.tools.video)).toBe("5");
    expect(defaultModelValue(caps.tools.image)).toBe("");
    expect(defaultModelValue(caps.tools.video)).toBe("");
});
