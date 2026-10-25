/** 市场抽屉「常用高级」分层 + 便捷预设 + 扩展捷径（R18 感知刀）。 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    applyMarketConvenienceChange,
    buildDefaultRunValues,
    buildToivRunValues,
    enrichMarketSchemaWithDeepParams,
    marketAppSupportsLoras,
    h3LengthFromSeconds,
    isMarketCoreParam,
    ltxFramesFromSeconds,
    marketConvenienceParams,
    mergeMarketModeChips,
    normalizeToivAppParam,
    parseResolutionPreset,
    splitMarketRunParams,
    splitMarketRunParamsWithConvenience,
    type ToivAppParam,
} from "../src/services/toiv/market-run";

const H3_SCHEMA: ToivAppParam[] = [
    normalizeToivAppParam({ key: "positive", label: "提示词", type: "textarea", default: "", required: true }),
    normalizeToivAppParam({ key: "width", label: "宽度", type: "number", default: 1344 }),
    normalizeToivAppParam({ key: "height", label: "高度", type: "number", default: 768 }),
    normalizeToivAppParam({ key: "length", label: "帧数", type: "number", default: 124 }),
    normalizeToivAppParam({ key: "steps", label: "采样步数", type: "number", default: 20 }),
    normalizeToivAppParam({ key: "seed", label: "随机种子", type: "text", default: "" }),
];

const T2I_SCHEMA: ToivAppParam[] = [
    normalizeToivAppParam({ key: "positive", label: "提示词", type: "textarea", default: "" }),
    normalizeToivAppParam({ key: "negative", label: "负向提示词", type: "textarea", default: "" }),
    normalizeToivAppParam({ key: "width", label: "宽度", type: "number", default: 1024 }),
    normalizeToivAppParam({ key: "height", label: "高度", type: "number", default: 1024 }),
    normalizeToivAppParam({ key: "steps", label: "采样步数", type: "number", default: 20 }),
    normalizeToivAppParam({ key: "cfg", label: "CFG", type: "number", default: 1 }),
    normalizeToivAppParam({ key: "seed", label: "随机种子", type: "text", default: "" }),
];

describe("market advanced param split", () => {
    test("isMarketCoreParam keeps prompt/size; steps/seed/cfg/negative are advanced", () => {
        expect(isMarketCoreParam(H3_SCHEMA[0])).toBe(true);
        expect(isMarketCoreParam(H3_SCHEMA.find((p) => p.key === "width")!)).toBe(true);
        expect(isMarketCoreParam(H3_SCHEMA.find((p) => p.key === "steps")!)).toBe(false);
        expect(isMarketCoreParam(H3_SCHEMA.find((p) => p.key === "seed")!)).toBe(false);
        expect(isMarketCoreParam(T2I_SCHEMA.find((p) => p.key === "negative")!)).toBe(false);
        expect(isMarketCoreParam(T2I_SCHEMA.find((p) => p.key === "cfg")!)).toBe(false);
    });

    test("splitMarketRunParams groups advanced knobs", () => {
        const { core, advanced } = splitMarketRunParams(T2I_SCHEMA);
        expect(core.map((p) => p.key)).toContain("positive");
        expect(core.map((p) => p.key)).toContain("width");
        expect(advanced.map((p) => p.key).sort()).toEqual(["cfg", "negative", "seed", "steps"]);
    });

    test("convenience resolution/duration write real schema keys into run payload", () => {
        const { core, advanced, convenience } = splitMarketRunParamsWithConvenience(H3_SCHEMA);
        expect(convenience.map((p) => p.key)).toEqual(["_ui_resolution", "_ui_duration"]);
        // 宽高/帧数被挪进高级，避免与预设重复吓新手
        expect(core.map((p) => p.key)).toEqual(["positive"]);
        expect(advanced.map((p) => p.key)).toEqual(
            expect.arrayContaining(["width", "height", "length", "steps", "seed"]),
        );

        let values = buildDefaultRunValues(H3_SCHEMA);
        for (const c of convenience) {
            values[c.key] = c.default;
            values = applyMarketConvenienceChange(H3_SCHEMA, c.key, c.default, values);
        }
        values = applyMarketConvenienceChange(H3_SCHEMA, "_ui_resolution", "832x480", values);
        values = applyMarketConvenienceChange(H3_SCHEMA, "_ui_duration", "15", values);
        values.steps = 12;
        values.seed = "42";
        values.positive = "雨夜街头";

        const payload = buildToivRunValues(H3_SCHEMA, values);
        expect(payload.width).toBe(832);
        expect(payload.height).toBe(480);
        expect(payload.length).toBe(h3LengthFromSeconds(15));
        expect(payload.steps).toBe(12);
        expect(payload.seed).toBe("42");
        expect(payload).not.toHaveProperty("_ui_resolution");
        expect(payload).not.toHaveProperty("_ui_duration");
    });

    test("h3/ltx duration grid helpers", () => {
        expect(h3LengthFromSeconds(5)).toBe(124);
        expect(h3LengthFromSeconds(15)).toBe(362);
        expect(ltxFramesFromSeconds(6)).toBe(97);
        expect(parseResolutionPreset("1280x736")).toEqual({ width: 1280, height: 736 });
        expect(parseResolutionPreset("bad")).toBeNull();
    });

    test("mergeMarketModeChips adds r2v-voice / 15s-fast when missing", () => {
        const merged = mergeMarketModeChips("h3-r2v", [{ label: "多图参考", app_id: "rh-acc-1", desc: "" }]);
        expect(merged.some((m) => m.app_id === "h3-r2v-voice")).toBe(true);
        expect(merged.some((m) => m.app_id === "rh-acc-1")).toBe(true);

        const t2v = mergeMarketModeChips("h3-t2v", [{ label: "15秒加速", app_id: "h3-t2v-15s-fast" }]);
        expect(t2v.filter((m) => m.app_id === "h3-t2v-15s-fast")).toHaveLength(1);
    });

    test("marketConvenienceParams skips when schema already has resolution/duration", () => {
        const withRes: ToivAppParam[] = [
            ...H3_SCHEMA,
            normalizeToivAppParam({
                key: "resolution",
                label: "分辨率",
                type: "select",
                default: "1280x736",
                options: [{ value: "1280x736", label: "720p" }],
            }),
            normalizeToivAppParam({
                key: "duration",
                label: "时长",
                type: "select",
                default: "5",
                options: [{ value: "5", label: "5 秒" }],
            }),
        ];
        expect(marketConvenienceParams(withRes)).toEqual([]);
    });
});

describe("market-page mounts 常用高级", () => {
    test("drawer source wires toggle + split helpers + run payload path", () => {
        const src = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
        expect(src).toContain("常用高级");
        expect(src).toContain("data-testid=\"market-advanced-toggle\"");
        expect(src).toContain("splitMarketRunParamsWithConvenience");
        expect(src).toContain("mergeMarketModeChips");
        expect(src).toContain("applyMarketConvenienceChange");
        expect(src).toContain("buildToivRunValues");
    });
});

describe("market deep params (LoRA / resolution_target)", () => {
    test("enrich adds loras+resolution_target for h3; longcat only resolution_target; no segment_extend", () => {
        const h3 = enrichMarketSchemaWithDeepParams("h3-t2v", H3_SCHEMA);
        expect(h3.map((p) => p.key)).toEqual(
            expect.arrayContaining(["loras", "resolution_target"]),
        );
        expect(h3.some((p) => p.key === "segment_extend")).toBe(false);
        const loras = h3.find((p) => p.key === "loras")!;
        expect(loras.type).toBe("loras");
        expect(loras.default).toEqual([]);

        const longcat = enrichMarketSchemaWithDeepParams("longcat-t2v", H3_SCHEMA);
        expect(longcat.some((p) => p.key === "loras")).toBe(false);
        expect(longcat.some((p) => p.key === "resolution_target")).toBe(true);

        const t2i = enrichMarketSchemaWithDeepParams("txt2img-basic", T2I_SCHEMA);
        expect(t2i.some((p) => p.key === "loras")).toBe(true);
        expect(t2i.some((p) => p.key === "resolution_target")).toBe(false);
        expect(enrichMarketSchemaWithDeepParams("qwen-image-edit", T2I_SCHEMA).some((p) => p.key === "loras")).toBe(
            true,
        );
    });

    test("split puts loras/resolution_target into deep, not advanced", () => {
        const schema = enrichMarketSchemaWithDeepParams("h3-t2v", H3_SCHEMA);
        const { advanced, deep } = splitMarketRunParamsWithConvenience(schema);
        expect(deep.map((p) => p.key).sort()).toEqual(["loras", "resolution_target"]);
        expect(advanced.map((p) => p.key)).not.toContain("loras");
        expect(advanced.map((p) => p.key)).not.toContain("resolution_target");
    });

    test("buildToivRunValues passes pinned loras and resolution_target", () => {
        const schema = enrichMarketSchemaWithDeepParams("h3-t2v", H3_SCHEMA);
        const values = buildDefaultRunValues(schema);
        values.positive = "雨夜";
        values.loras = [{ name: "cxy_kiss_lora_h3_v01_step1500.safetensors", strength: 0.7 }];
        values.resolution_target = "1080p";
        const payload = buildToivRunValues(schema, values);
        expect(payload.loras).toEqual([
            { name: "cxy_kiss_lora_h3_v01_step1500.safetensors", strength: 0.7 },
        ]);
        expect(payload.resolution_target).toBe("1080p");
        expect(payload).not.toHaveProperty("segment_extend");
    });

    test("buildToivRunValues keeps empty loras array (off)", () => {
        const schema = enrichMarketSchemaWithDeepParams("h3-i2v", H3_SCHEMA);
        const values = buildDefaultRunValues(schema);
        expect(values.loras).toEqual([]);
        const payload = buildToivRunValues(schema, values);
        expect(payload.loras).toEqual([]);
    });

    test("buildToivRunValues preserves null loras for AI mode", () => {
        const schema = enrichMarketSchemaWithDeepParams("h3-t2v", H3_SCHEMA);
        const values = buildDefaultRunValues(schema);
        values.loras = null;
        values.positive = "a";
        const payload = buildToivRunValues(schema, values);
        expect(payload.loras).toBeNull();
    });
});

describe("market-page mounts 更深参数", () => {
    test("drawer source wires deep toggle + enrich + loras field", () => {
        const src = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
        expect(src).toContain("更深参数");
        expect(src).toContain("data-testid=\"market-deep-toggle\"");
        expect(src).toContain("enrichMarketSchemaWithDeepParams");
        expect(src).toContain("data-testid=\"market-loras-field\"");
        expect(src).not.toContain("segment_extend");
    });
});

describe("marketAppSupportsLoras image wiring 2026-10-26", () => {
    test("covers local image apps including qwen-image-edit", () => {
        for (const id of ["txt2img", "img2img", "nsfw-txt2img", "nsfw-img2img", "txt2img-basic", "img2img-basic", "qwen-image-edit"]) {
            expect(marketAppSupportsLoras(id)).toBe(true);
        }
        expect(marketAppSupportsLoras("h3-t2v")).toBe(true);
        expect(marketAppSupportsLoras("ltx-txt2video")).toBe(true);
        expect(marketAppSupportsLoras("longcat-t2v")).toBe(false);
    });
});
