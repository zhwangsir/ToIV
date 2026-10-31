/**
 * 角色资产画风变体（CHARACTER_ASSET_PROTOCOL M2 / AUDIT「变体 UI 下单」）。
 *
 * 词表对齐 `apps/api/.../character_asset.STYLE_VARIANTS` 与
 * `character_sheet.templates.SHEET_STYLES`（六档均可经 submitSheetAsync 下单）。
 * 扩展档走同一设定卡 API：prompt-pack / style_key + ckpt/theme 映射，无新微服务。
 */

export type CharacterStyleVariantKey =
    | "ancient_realistic"
    | "anime"
    | "realistic"
    | "ink_wash"
    | "cyberpunk"
    | "three_d";

export type CharacterStyleVariantSpec = {
    key: CharacterStyleVariantKey;
    zh: string;
    /** true = 可经 submitSheetAsync 下单 */
    sheetOrderable: boolean;
};

export const CHARACTER_STYLE_VARIANTS: CharacterStyleVariantSpec[] = [
    { key: "ancient_realistic", zh: "古风写实", sheetOrderable: true },
    { key: "anime", zh: "二次元", sheetOrderable: true },
    { key: "realistic", zh: "写实", sheetOrderable: true },
    { key: "ink_wash", zh: "水墨", sheetOrderable: true },
    { key: "cyberpunk", zh: "赛博朋克", sheetOrderable: true },
    { key: "three_d", zh: "3D", sheetOrderable: true },
];

export const SHEET_ORDERABLE_STYLES = CHARACTER_STYLE_VARIANTS.filter((s) => s.sheetOrderable).map((s) => s.key);

/** 设定卡已有 styles 之外、仍可 sheet 下单的变体。 */
export function pendingSheetVariantOrders(existingStyles: Iterable<string>): CharacterStyleVariantSpec[] {
    const have = new Set([...existingStyles].map((s) => s.trim()).filter(Boolean));
    return CHARACTER_STYLE_VARIANTS.filter((s) => s.sheetOrderable && !have.has(s.key));
}

/** @deprecated 六档均已可 sheet 下单；保留常量以免旧引用炸。 */
export const EXTENDED_VARIANT_API_GAP = "";
