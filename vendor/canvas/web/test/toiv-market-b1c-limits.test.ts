import { describe, expect, test } from "bun:test";

import {
    buildToivRunValues,
    formatMarketByteLimit,
    MARKET_MEDIA_FALLBACK_BYTES,
    marketRunValidation,
    marketTextLimitState,
    normalizeToivAppParam,
    resolveLoraItemCap,
    resolveMarketMediaByteLimit,
} from "../src/services/toiv/market-run";

describe("toiv market B1c：声明式上限透传（max_chars/max_bytes/max_items）", () => {
    test("normalizeToivAppParam 透传三个声明字段", () => {
        const p = normalizeToivAppParam({
            key: "prompt",
            label: "提示词",
            type: "textarea",
            default: "",
            max_chars: 500,
        });
        expect(p.max_chars).toBe(500);

        const m = normalizeToivAppParam({
            key: "video",
            label: "驱动视频",
            type: "video",
            default: null,
            max_bytes: 50 * 1024 * 1024,
        });
        expect(m.max_bytes).toBe(50 * 1024 * 1024);

        const l = normalizeToivAppParam({
            key: "loras",
            label: "LoRA",
            type: "loras",
            default: null,
            max_items: 5,
        });
        expect(l.max_items).toBe(5);
    });

    test("未声明或非法声明保持 undefined（不伪称知道模型能力）", () => {
        const bare = normalizeToivAppParam({ key: "prompt", label: "提示词", type: "textarea", default: "" });
        expect(bare.max_chars).toBeUndefined();
        expect(bare.max_bytes).toBeUndefined();
        expect(bare.max_items).toBeUndefined();

        const junk = normalizeToivAppParam({
            key: "prompt",
            label: "提示词",
            type: "textarea",
            default: "",
            max_chars: "abc",
            max_bytes: -1,
            max_items: Number.NaN,
        });
        expect(junk.max_chars).toBeUndefined();
        expect(junk.max_bytes).toBeUndefined();
        expect(junk.max_items).toBeUndefined();
    });
});

describe("toiv market B1c：媒体字节上限（声明优先，缺省兼容回退）", () => {
    test("param 声明 max_bytes 时按声明拦截", () => {
        expect(
            resolveMarketMediaByteLimit({ type: "video", max_bytes: 1024 * 1024 }),
        ).toBe(1024 * 1024);
        expect(
            resolveMarketMediaByteLimit({ type: "images", max_bytes: 5 * 1024 * 1024 }),
        ).toBe(5 * 1024 * 1024);
    });

    test("未声明时维持 B1c 前页面硬编码（兼容回退，非模型能力声明）", () => {
        expect(resolveMarketMediaByteLimit({ type: "images" })).toBe(MARKET_MEDIA_FALLBACK_BYTES.images);
        expect(resolveMarketMediaByteLimit({ type: "audio" })).toBe(MARKET_MEDIA_FALLBACK_BYTES.audio);
        expect(resolveMarketMediaByteLimit({ type: "video" })).toBe(MARKET_MEDIA_FALLBACK_BYTES.video);
        expect(MARKET_MEDIA_FALLBACK_BYTES.images).toBe(20 * 1024 * 1024);
        expect(MARKET_MEDIA_FALLBACK_BYTES.audio).toBe(20 * 1024 * 1024);
        expect(MARKET_MEDIA_FALLBACK_BYTES.video).toBe(200 * 1024 * 1024);
    });

    test("formatMarketByteLimit 对 MB 整除显示 MB，否则显示 KB/B", () => {
        expect(formatMarketByteLimit(20 * 1024 * 1024)).toBe("20MB");
        expect(formatMarketByteLimit(200 * 1024 * 1024)).toBe("200MB");
        expect(formatMarketByteLimit(512 * 1024)).toBe("512KB");
        expect(formatMarketByteLimit(700)).toBe("700B");
    });
});

describe("toiv market B1c：LoRA 数量上限（max_items 优先，缺省回退 3）", () => {
    test("声明 max_items 时按其封顶", () => {
        expect(resolveLoraItemCap({ max_items: 5 })).toBe(5);
        expect(resolveLoraItemCap({ max_items: 1 })).toBe(1);
        expect(resolveLoraItemCap({ max_items: 0 })).toBe(0);
    });

    test("未声明时回退 3（B1c 前硬编码，兼容回退）", () => {
        expect(resolveLoraItemCap({})).toBe(3);
    });
});

describe("toiv market B1c：文本字数反馈", () => {
    test("声明 max_chars 时给出计数与超限标记", () => {
        const s = marketTextLimitState("一二三四五六七八九十", 10);
        expect(s.declared).toBe(true);
        expect(s.count).toBe(10);
        expect(s.max).toBe(10);
        expect(s.over).toBe(false);

        const over = marketTextLimitState("一二三四五六七八九十1", 10);
        expect(over.count).toBe(11);
        expect(over.over).toBe(true);
    });

    test("未声明时不给计数（不伪称限制）", () => {
        const s = marketTextLimitState("任意长度文本", undefined);
        expect(s.declared).toBe(false);
        expect(s.max).toBeNull();
        expect(s.over).toBe(false);
    });

    test("按码点计数，增补平面字符不拆半个字", () => {
        expect(marketTextLimitState("😀", 10).count).toBe(1);
        expect(marketTextLimitState("😀😀", 1).over).toBe(true);
    });
});

describe("toiv market B1c：buildToivRunValues 按 max_items 提交 LoRA", () => {
    const five = [
        { name: "a", strength: 0.6 },
        { name: "b", strength: 0.7 },
        { name: "c", strength: 0.8 },
        { name: "d", strength: 0.9 },
        { name: "e", strength: 1.0 },
    ];

    test("max_items=5 提交不丢第 4/5 项", () => {
        const schema = [normalizeToivAppParam({ key: "loras", label: "LoRA", type: "loras", default: null, max_items: 5 })];
        const out = buildToivRunValues(schema, { loras: five });
        expect((out.loras as unknown[]).length).toBe(5);
        expect(out.loras).toEqual(five);
    });

    test("max_items=2 明确按声明封顶到 2（UI 已禁选第 3 项，这里是契约对齐非静默掩盖）", () => {
        const schema = [normalizeToivAppParam({ key: "loras", label: "LoRA", type: "loras", default: null, max_items: 2 })];
        const out = buildToivRunValues(schema, { loras: five });
        expect((out.loras as unknown[]).length).toBe(2);
        expect(out.loras).toEqual(five.slice(0, 2));
    });

    test("未声明 max_items 保持旧行为 cap=3（兼容回退）", () => {
        const schema = [normalizeToivAppParam({ key: "loras", label: "LoRA", type: "loras", default: null })];
        const out = buildToivRunValues(schema, { loras: five });
        expect((out.loras as unknown[]).length).toBe(3);
    });

    test("null=AI / []=关闭 语义不受 max_items 影响", () => {
        const schema = [normalizeToivAppParam({ key: "loras", label: "LoRA", type: "loras", default: null, max_items: 2 })];
        expect(buildToivRunValues(schema, { loras: null }).loras).toBeNull();
        expect(buildToivRunValues(schema, { loras: [] }).loras).toEqual([]);
    });
});

describe("toiv market B1c：marketRunValidation 提交前校验（一套入口）", () => {
    const schema = [
        normalizeToivAppParam({ key: "prompt", label: "提示词", type: "textarea", default: null, max_chars: 10, required: true }),
        normalizeToivAppParam({ key: "note", label: "备注", type: "text", default: "", max_chars: 5 }),
        normalizeToivAppParam({ key: "free", label: "自由文本", type: "textarea", default: "" }),
    ];

    test("必填缺口仍由同一入口报 missing", () => {
        const v = marketRunValidation(schema, { prompt: "", note: "", free: "" });
        expect(v?.kind).toBe("missing");
        expect(v?.label).toBe("提示词");
    });

    test("声明 max_chars 的超限文本阻断提交（text_over）", () => {
        const v = marketRunValidation(schema, { prompt: "一二三四五六七八九十1", note: "", free: "" });
        expect(v?.kind).toBe("text_over");
        expect(v?.label).toBe("提示词");
        expect(v?.message).toContain("10");
    });

    test("恰好等于 max_chars 不阻断（边界）", () => {
        const v = marketRunValidation(schema, { prompt: "一二三四五六七八九十", note: "12345", free: "" });
        expect(v).toBeNull();
    });

    test("未声明 max_chars 的文本再长也不阻断（兼容，不伪称限制）", () => {
        const v = marketRunValidation(schema, { prompt: "一二三四五六七八九十", note: "", free: "很长很长很长很长很长很长的自由文本" });
        expect(v).toBeNull();
    });

    test("text 类型同样受 max_chars 约束", () => {
        const v = marketRunValidation(schema, { prompt: "一二三四五六七八九十", note: "123456", free: "" });
        expect(v?.kind).toBe("text_over");
        expect(v?.label).toBe("备注");
    });
});

describe("toiv market B1c：marketRunValidation 拦截 LoRA 超 max_items（不依赖 build 层 slice）", () => {
    const three = [
        { name: "a", strength: 0.6 },
        { name: "b", strength: 0.7 },
        { name: "c", strength: 0.8 },
    ];
    const loraSchema = (max_items?: number) => [
        normalizeToivAppParam({
            key: "loras",
            label: "LoRA 叠加",
            type: "loras",
            default: [],
            ...(max_items === undefined ? {} : { max_items }),
        }),
    ];

    test("max_items=2 时 3 个命名 LoRA 被拒，给出明确原因", () => {
        const v = marketRunValidation(loraSchema(2), { loras: three });
        expect(v?.kind).toBe("loras_over");
        expect(v?.label).toBe("LoRA 叠加");
        expect(v?.message).toContain("2");
        expect(v?.message).toContain("3");
    });

    test("恰好等于 max_items 放行（边界）", () => {
        expect(marketRunValidation(loraSchema(3), { loras: three })).toBeNull();
    });

    test("null=AI 选配 / []=关闭 均放行", () => {
        expect(marketRunValidation(loraSchema(2), { loras: null })).toBeNull();
        expect(marketRunValidation(loraSchema(2), { loras: [] })).toBeNull();
    });

    test("未声明 max_items 时不拒绝（兼容回退，build 层防御性 slice 兜底的旧行为不破）", () => {
        expect(marketRunValidation(loraSchema(undefined), { loras: three })).toBeNull();
        expect(marketRunValidation(loraSchema(undefined), { loras: [...three, { name: "d", strength: 0.9 }, { name: "e", strength: 1 }] })).toBeNull();
    });

    test("max_items=5 选 5 个照常放行（既有用例语义不破）", () => {
        const five = [...three, { name: "d", strength: 0.9 }, { name: "e", strength: 1 }];
        expect(marketRunValidation(loraSchema(5), { loras: five })).toBeNull();
    });

    test("非数组脏值不触发 loras_over（交给 build 层归一）", () => {
        expect(marketRunValidation(loraSchema(2), { loras: "oops" })).toBeNull();
        expect(marketRunValidation(loraSchema(2), { loras: undefined })).toBeNull();
    });
});
