import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    CHARACTER_STYLE_VARIANTS,
    EXTENDED_VARIANT_API_GAP,
    pendingSheetVariantOrders,
    SHEET_ORDERABLE_STYLES,
} from "../src/services/toiv/character-style-variants";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("角色资产画风变体目录", () => {
    test("六档词表齐，全部可 sheet 下单", () => {
        expect(CHARACTER_STYLE_VARIANTS.map((s) => s.key)).toEqual([
            "ancient_realistic",
            "anime",
            "realistic",
            "ink_wash",
            "cyberpunk",
            "three_d",
        ]);
        expect(SHEET_ORDERABLE_STYLES).toEqual([
            "ancient_realistic",
            "anime",
            "realistic",
            "ink_wash",
            "cyberpunk",
            "three_d",
        ]);
        expect(CHARACTER_STYLE_VARIANTS.every((s) => s.sheetOrderable)).toBe(true);
    });

    test("pendingSheetVariantOrders 排除已有 style", () => {
        const pending = pendingSheetVariantOrders(["anime"]);
        expect(pending.map((s) => s.key)).toEqual([
            "ancient_realistic",
            "realistic",
            "ink_wash",
            "cyberpunk",
            "three_d",
        ]);
        expect(pendingSheetVariantOrders(SHEET_ORDERABLE_STYLES)).toEqual([]);
    });

    test("扩展档缺口文案已清空（六档均已接线）", () => {
        expect(EXTENDED_VARIANT_API_GAP).toBe("");
    });
});

describe("drama-workspace 变体下单接线", () => {
    const page = read("src/pages/toiv/drama-workspace.tsx");
    const client = read("src/services/toiv/client.ts");

    test("设定卡抽屉有下单变体区，走 submitSheetAsync / regenSheet", () => {
        expect(page).toContain('data-testid="character-variant-order"');
        expect(page).toContain("下单变体：");
        expect(page).toContain("pendingSheetVariantOrders");
        expect(page).toContain("fetchCharacterAsset");
    });

    test("client 暴露 fetchCharacterAsset", () => {
        expect(client).toContain("export async function fetchCharacterAsset");
        expect(client).toContain("/character-asset");
    });
});
