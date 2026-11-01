import { afterEach, expect, test } from "bun:test";
import { normalizeCapabilities, refreshModelEndpoints } from "../src/toiv/adapters/capabilities";
import {
    LOCAL_PRICING, SETTINGS_SECTIONS, buildModelSheet, settingsIssueMarkers,
} from "../src/toiv/adapters/settings";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const CAPS = normalizeCapabilities({
    schema_version: 1,
    tools: {
        image: { id: "image", label: "文生图", available: true },
        video: { id: "video", label: "文生视频", available: true },
    },
    slots: [
        {
            id: "image", label: "出图", available: true, unavailable_reason: null,
            affects: ["工具中心 · 文生图", "项目 · 分镜首帧"],
            engines: [{
                id: "txt2img", label: "文生图", kind: "image", nsfw: false,
                description: "基础出图", route: "/api/generate/txt2img",
                available: true, unavailable_reason: null,
                params: [
                    {
                        key: "ckpt_name", label: "底模", type: "select", default: "z_image.safetensors",
                        options: [
                            { value: "z_image.safetensors", label: "Z-Image" },
                            { value: "sdxl.safetensors", label: "SDXL" },
                        ],
                    },
                    { key: "width", label: "宽", type: "int", default: 1024, min: 64, max: 2048, step: 8 },
                ],
                limits: { prompt_max_chars: 2000 },
            }],
        },
        {
            id: "video", label: "视频", available: false, unavailable_reason: "H3 实例不可达",
            affects: ["工具中心 · 文生视频", "流水线 · 分镜渲染"],
            engines: [{
                id: "h3-t2v", label: "H3 文生视频", kind: "video", nsfw: false,
                description: "H3 管线", route: "/api/h3/t2v",
                available: false, unavailable_reason: "H3 实例不可达",
                params: [{
                    key: "duration", label: "时长", type: "select", default: "5",
                    options: [
                        { value: "5", label: "5 秒" },
                        { value: "10", label: "10 秒" },
                    ],
                }],
                limits: {},
            }],
        },
        {
            id: "avatar", label: "数字人", available: false, unavailable_reason: "暂无已注册引擎",
            affects: ["流水线 · 数字人口播"], engines: [],
        },
        {
            id: "audio", label: "音乐", available: true, unavailable_reason: null,
            affects: ["配音 · 台词配音"],
            engines: [{
                id: "ace-step", label: "ACE-Step", kind: "audio", nsfw: false,
                description: "音乐生成", route: "/api/generate/audio",
                available: true, unavailable_reason: null,
                params: [{ key: "tags", label: "风格", type: "text", default: "" }],
                limits: {},
            }],
        },
    ],
    issues: [
        { id: "slot-video-empty", title: "视频槽位暂无可用引擎", reason: "H3 实例不可达", affects: ["工具中心 · 文生视频"] },
        { id: "slot-avatar-empty", title: "数字人槽位暂无可用引擎", reason: "暂无已注册引擎", affects: ["流水线 · 数字人口播"] },
    ],
});

test("settings sections expose the nav model with issue markers", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual(["外观", "颜色", "排版", "模型与渠道"]);
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual(["appearance", "colors", "layout", "models"]);

    expect(settingsIssueMarkers(CAPS, { contrastOk: true })).toEqual({
        appearance: 0, colors: 0, layout: 0, models: 2,
    });
    expect(settingsIssueMarkers(CAPS, { contrastOk: false })).toMatchObject({ colors: 1, models: 2 });
    expect(settingsIssueMarkers(null, { contrastOk: true, modelsError: true })).toEqual({
        appearance: 0, colors: 0, layout: 0, models: 1,
    });
});

test("model sheet groups business slots with pricing, params, durations and coverage", () => {
    const sheet = buildModelSheet(CAPS);

    expect(sheet.groups.map((group) => group.id)).toEqual(["image", "video", "avatar", "audio"]);
    expect(sheet.total).toBe(4);
    expect(sheet.available).toBe(2);
    expect(sheet.issues).toBe(2);

    const image = sheet.groups[0];
    expect(image.label).toBe("出图");
    expect(image.price).toBe(LOCAL_PRICING.label);
    expect(image.priceNote).toContain("不按次计费");
    expect(image.coverage).toEqual(["工具中心 · 文生图", "项目 · 分镜首帧"]);
    expect(image.impact).toEqual([]);
    expect(image.engines[0]).toMatchObject({
        id: "txt2img", available: true, route: "/api/generate/txt2img",
    });
    expect(image.engines[0].params).toContainEqual({
        key: "ckpt_name", label: "底模", summary: "默认 Z-Image · 共 2 档",
    });
    expect(image.engines[0].params).toContainEqual({ key: "width", label: "宽", summary: "64–2048" });
    expect(image.engines[0].durations).toEqual([]);

    const video = sheet.groups[1];
    expect(video.available).toBe(false);
    expect(video.impact).toEqual(["工具中心 · 文生视频", "流水线 · 分镜渲染"]);
    expect(video.engines[0].durations).toEqual(["5 秒", "10 秒"]);
    expect(video.issues.map((issue) => issue.id)).toEqual(["slot-video-empty"]);

    const avatar = sheet.groups[2];
    expect(avatar.engines).toEqual([]);
    expect(avatar.issues.map((issue) => issue.id)).toEqual(["slot-avatar-empty"]);
    expect(avatar.impact).toEqual(["流水线 · 数字人口播"]);

    expect(sheet.groups[3].issues).toEqual([]);
});

test("an unavailable capability payload produces an empty, explicit sheet", () => {
    const sheet = buildModelSheet(null);
    expect(sheet.groups).toEqual([]);
    expect(sheet.total).toBe(0);
    expect(sheet.available).toBe(0);
});

test("endpoint probe refreshes engines and reports availability", async () => {
    let seen: { url: string; method: string; auth: string | null } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen = { url: String(input), method: init?.method ?? "GET", auth: headers.get("Authorization") };
        return json({
            count: 2,
            engines: [
                { id: "txt2img", label: "文生图", kind: "image", available: true, submit: { route: "/api/generate/txt2img" } },
                {
                    id: "h3-t2v", label: "H3 文生视频", kind: "video", available: false,
                    unavailable_reason: "H3 实例不可达", submit: { route: "/api/h3/t2v" },
                },
            ],
        });
    }) as typeof fetch;
    const originalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: (key: string) => (key === "toiv_token" ? "tok-1" : null) },
    });

    const result = await refreshModelEndpoints();

    expect(seen).toEqual({ url: "/api/models/engines/refresh", method: "POST", auth: "Bearer tok-1" });
    expect(result.count).toBe(2);
    expect(result.availableCount).toBe(1);
    expect(result.engines[1]).toMatchObject({
        id: "h3-t2v", available: false, reason: "H3 实例不可达", route: "/api/h3/t2v",
    });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
});

test("endpoint probe failures surface the backend detail", async () => {
    globalThis.fetch = (async () => json({ detail: "引擎注册表不可用" }, 503)) as typeof fetch;
    await expect(refreshModelEndpoints()).rejects.toThrow("引擎注册表不可用");
});
