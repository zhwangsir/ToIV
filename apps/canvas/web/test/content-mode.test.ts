/** content_mode 挂载面单测:解析/门控 fail-closed + 经典引擎→市场映射。 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    CLASSIC_NSFW_TO_MARKET,
    appIsPureNsfw,
    appShowsR18Badge,
    appVisibleForContentMode,
    canShowContentModeToggle,
    normalizeContentModeFields,
    normalizeContentModes,
    resolveSubmitContentMode,
} from "../src/services/toiv/content-mode";

describe("content-mode pure helpers", () => {
    test("normalizeContentModes defaults and dedupes", () => {
        expect(normalizeContentModes(undefined)).toEqual(["sfw"]);
        expect(normalizeContentModes(["SFW", "nsfw", "nsfw", "x"])).toEqual(["sfw", "nsfw"]);
    });

    test("normalizeContentModeFields fills is_nsfw / twin id", () => {
        const twin = normalizeContentModeFields({
            id: "h3-t2v",
            content_modes: ["sfw", "nsfw"],
            nsfw_variant_id: "h3-nsfw-t2v",
        });
        expect(twin.is_nsfw).toBe(false);
        expect(twin.content_modes).toEqual(["sfw", "nsfw"]);
        expect(twin.nsfw_variant_id).toBe("h3-nsfw-t2v");

        const pure = normalizeContentModeFields({ id: "ltx-txt2video", is_nsfw: true });
        expect(pure.is_nsfw).toBe(true);
        expect(pure.content_modes).toContain("nsfw");
    });

    test("canShowContentModeToggle requires R18 + dual modes", () => {
        const dual = { content_modes: ["sfw", "nsfw"] };
        expect(canShowContentModeToggle(dual, false)).toBe(false);
        expect(canShowContentModeToggle(dual, true)).toBe(true);
        expect(canShowContentModeToggle({ is_nsfw: true, content_modes: ["nsfw"] }, true)).toBe(false);
        expect(canShowContentModeToggle(null, true)).toBe(false);
    });

    test("resolveSubmitContentMode fail-closed when R18 off", () => {
        const dual = { content_modes: ["sfw", "nsfw"], is_nsfw: false };
        expect(
            resolveSubmitContentMode({ app: dual, r18On: false, selected: "nsfw" }),
        ).toBe("sfw");
        expect(
            resolveSubmitContentMode({ app: dual, r18On: true, selected: "nsfw" }),
        ).toBe("nsfw");
        expect(
            resolveSubmitContentMode({ app: dual, r18On: true, selected: "sfw" }),
        ).toBe("sfw");
        expect(
            resolveSubmitContentMode({
                app: { is_nsfw: true, content_modes: ["nsfw"] },
                r18On: true,
                selected: "sfw",
            }),
        ).toBe("nsfw");
        expect(
            resolveSubmitContentMode({
                app: { is_nsfw: true, content_modes: ["nsfw"] },
                r18On: false,
                selected: "nsfw",
            }),
        ).toBe("sfw");
    });

    test("appShowsR18Badge for twin parents and pure NSFW", () => {
        expect(appShowsR18Badge({ content_modes: ["sfw", "nsfw"] })).toBe(true);
        expect(appShowsR18Badge({ is_nsfw: true })).toBe(true);
        expect(appShowsR18Badge({ content_modes: ["sfw"] })).toBe(false);
    });

    test("appIsPureNsfw + appVisibleForContentMode ordinary/adult", () => {
        const pure = { is_nsfw: true, content_modes: ["nsfw"] };
        const dual = { content_modes: ["sfw", "nsfw"] };
        expect(appIsPureNsfw(pure)).toBe(true);
        expect(appIsPureNsfw(dual)).toBe(false);
        expect(appVisibleForContentMode(pure, false)).toBe(false);
        expect(appVisibleForContentMode(pure, true)).toBe(true);
        expect(appVisibleForContentMode(dual, false)).toBe(true);
    });

    test("CLASSIC_NSFW_TO_MARKET covers #9A engine list", () => {
        const ids = CLASSIC_NSFW_TO_MARKET.map((x) => x.classicEngineId);
        for (const need of [
            "nsfw-txt2img",
            "nsfw-img2img",
            "h3-nsfw-t2v",
            "h3-nsfw-i2v",
            "h3-nsfw-fl2v",
            "h3-nsfw-r2v",
            "ltx-nsfw-t2v",
            "ltx-nsfw-i2v",
            "ltx-nsfw-lipsync",
            "wan-nsfw-i2v",
        ]) {
            expect(ids).toContain(need);
        }
        expect(CLASSIC_NSFW_TO_MARKET.find((x) => x.classicEngineId === "nsfw-txt2img")?.marketAppId).toBe(
            "txt2img-basic",
        );
        expect(CLASSIC_NSFW_TO_MARKET.find((x) => x.classicEngineId === "ltx-nsfw-t2v")?.via).toBe(
            "is_nsfw_app",
        );
    });
});

describe("content-mode market wiring (source contracts)", () => {
    const page = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
    const client = readFileSync(join(import.meta.dir, "../src/services/toiv/client.ts"), "utf8");

    test("runToivApp accepts content_mode body field", () => {
        expect(client).toContain("content_mode");
        expect(client).toContain("opts?.content_mode");
        expect(client).toContain("normalizeContentModeFields");
    });

    test("market drawer gates toggle + submits resolveSubmitContentMode", () => {
        expect(page).toContain("canShowContentModeToggle");
        expect(page).toContain("resolveSubmitContentMode");
        expect(page).toContain('content_mode: mode');
        expect(page).toContain('aria-label="内容模式"');
        expect(page).toContain('["r18", n]');
    });

    test("R18 off never hardcodes nsfw submit without resolve", () => {
        // 提交路径必须经 resolveSubmitContentMode,禁止裸 "nsfw" 字面量直传 run
        expect(page).toMatch(/runToivApp\([\s\S]*?content_mode:\s*mode/);
        expect(page).not.toMatch(/runToivApp\([^)]*content_mode:\s*"nsfw"/);
    });
});

describe("W1-A redline single lock (source)", () => {
    const redline = readFileSync(join(import.meta.dir, "../src/redline.ts"), "utf8");
    const contentMode = readFileSync(join(import.meta.dir, "../src/services/toiv/content-mode.ts"), "utf8");
    const page = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");

    test("predicates land only in redline", () => {
        for (const name of [
            "resolveSubmitContentMode",
            "appVisibleForContentMode",
            "appIsPureNsfw",
            "canShowContentModeToggle",
            "appShowsR18Badge",
        ]) {
            expect(redline).toContain(`export function ${name}`);
            expect(contentMode).not.toContain(`export function ${name}`);
            expect(contentMode).toContain(name);
        }
        expect(contentMode).toContain('from "@/redline"');
    });

    test("market consumes predicates from @/redline", () => {
        expect(page).toMatch(/resolveSubmitContentMode[\s\S]*from "@\/redline"|from "@\/redline"[\s\S]*resolveSubmitContentMode/);
        expect(page).toContain("appVisibleForContentMode");
        expect(page).toContain("canShowContentModeToggle");
    });
});
