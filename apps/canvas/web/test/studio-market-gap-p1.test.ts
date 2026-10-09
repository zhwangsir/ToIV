import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LOCAL_AUDIO_HAS_SENSEVOICE, LOCAL_AUDIO_UNAVAILABLE_LABEL } from "../src/lib/local-model-defaults";
import {
    appUploadKind,
    asMarketMediaList,
    buildToivRunValues,
    firstPinWorker,
    mediaFilenames,
    normalizeToivAppParam,
    requiredToivParamLabel,
    type ToivAppParam,
} from "../src/services/toiv/market-run";
import { isMarketAudioUnavailableApp } from "../src/services/toiv/local-capability-surface";

describe("studio-market-gap-p1 media helpers", () => {
    test("mediaFilenames extracts from handles and skips remote demo on submit", () => {
        expect(mediaFilenames([{ filename: "a.png", worker: "w1" }, "b.png"], { includeRemoteDemo: false })).toEqual([
            "a.png",
            "b.png",
        ]);
        expect(mediaFilenames(["https://cdn.example/demo.png"], { includeRemoteDemo: false })).toEqual([]);
        expect(mediaFilenames(["https://cdn.example/demo.png"], { includeRemoteDemo: true })).toEqual([
            "https://cdn.example/demo.png",
        ]);
    });

    test("buildToivRunValues media uses filenames not String(object)", () => {
        const schema: ToivAppParam[] = [
            normalizeToivAppParam({ key: "ref", label: "参考图", type: "images", default: null, required: true }),
        ];
        const out = buildToivRunValues(schema, {
            ref: [{ filename: "x.png", worker: "http://w1" }],
        });
        expect(out.ref).toEqual(["x.png"]);
    });

    test("requiredToivParamLabel ignores remote demo as filled media", () => {
        const schema: ToivAppParam[] = [
            normalizeToivAppParam({ key: "ref", label: "参考图", type: "images", default: null, required: true }),
        ];
        expect(requiredToivParamLabel(schema, { ref: ["https://cdn.example/a.png"] })).toBe("参考图");
        expect(requiredToivParamLabel(schema, { ref: [{ filename: "a.png", worker: "w" }] })).toBeNull();
    });

    test("appUploadKind maps local engines", () => {
        expect(appUploadKind("h3-t2v")).toBe("h3_i2v");
        expect(appUploadKind("wan-animate-2")).toBe("wan_animate2");
        expect(appUploadKind("wan-vace")).toBe("wan_vace");
        expect(appUploadKind("longcat-t2v")).toBe("avatar");
        expect(appUploadKind("generic-app")).toBe("img2img");
    });

    test("firstPinWorker and asMarketMediaList", () => {
        expect(firstPinWorker({ a: [{ filename: "a.png", worker: " http://w " }] })).toBe("http://w");
        const list = asMarketMediaList([{ filename: "a.png", worker: "w", name: "n" }]);
        expect(list[0]?.filename).toBe("a.png");
        expect(list[0]?.name).toBe("n");
    });
});

describe("studio-market-gap-p1 audio unavailable", () => {
    test("SenseVoice flag stays false and label contains 未接", () => {
        expect(LOCAL_AUDIO_HAS_SENSEVOICE).toBe(false);
        expect(LOCAL_AUDIO_UNAVAILABLE_LABEL).toContain("未接");
    });

    test("isMarketAudioUnavailableApp matches sense/asr apps only", () => {
        expect(isMarketAudioUnavailableApp({ id: "sensevoice-demo", name: "听写" })).toBe(true);
        expect(isMarketAudioUnavailableApp({ id: "ace-music", name: "音乐", category: "audio", description: "文生音乐" })).toBe(
            false,
        );
        expect(
            isMarketAudioUnavailableApp({
                id: "audio-x",
                name: "音频工具",
                category: "audio",
                description: "音频反推提示词",
            }),
        ).toBe(true);
    });
});

describe("studio-market-gap-p1 page contracts (source)", () => {
    const market = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
    const tasks = readFileSync(join(import.meta.dir, "../src/pages/toiv/tasks-page.tsx"), "utf8");
    const grid = readFileSync(join(import.meta.dir, "../src/pages/settings/model-default-grid.tsx"), "utf8");
    const compute = readFileSync(join(import.meta.dir, "../src/pages/settings/local-compute-pane.tsx"), "utf8");
    const client = readFileSync(join(import.meta.dir, "../src/services/toiv/client.ts"), "utf8");

    test("market page uploads media via uploadToivMedia (no stub copy)", () => {
        expect(market).toContain("uploadToivMedia");
        expect(market).toContain("MarketMediaField");
        expect(market).not.toContain("本页暂不支持上传媒体");
    });

    test("client exposes uploadToivMedia", () => {
        expect(client).toContain("export function uploadToivMedia");
        expect(client).toContain("/api/upload?");
    });

    test("config marks audio 未接 without fake entry", () => {
        expect(grid).toContain("audio-unavailable-notice");
        expect(grid).toContain("LOCAL_AUDIO_UNAVAILABLE_LABEL");
        expect(compute).toContain("local-audio-unavailable");
        expect(compute).toContain("LOCAL_AUDIO_UNAVAILABLE_LABEL");
    });

    test("tasks page exposes unified timeline + empty/skeleton", () => {
        expect(tasks).toContain("统一任务时间线");
        expect(tasks).toContain("listGenerationTasks");
        expect(tasks).toContain("TaskTimelineSkeleton");
        expect(tasks).toContain("还没有生成作业");
        expect(tasks).toContain('searchParams.get("job")');
    });
});
