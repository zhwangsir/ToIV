import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    HOME_INTENT_ENTRIES,
    HOME_INTENT_MARKET_LINKS,
    LOCAL_CREATE_PRESETS,
    LOCAL_H3_MODEL_REF,
    LOCAL_MARKET_FEATURED,
    localMarketFeaturedAppIds,
    resolveLocalCapabilityBadge,
    sortAppsWithFeaturedIds,
} from "../src/services/toiv/local-capability-surface";
import { LOCAL_IMAGE_MODEL_REF, LOCAL_VIDEO_CHANNEL_ID } from "../src/lib/local-model-defaults";

describe("local-capability-surface catalog", () => {
    test("featured pack covers local 7 + Wan", () => {
        const labels = LOCAL_MARKET_FEATURED.map((e) => e.label);
        for (const need of ["本地出图", "H3", "LongCat", "VACE", "Animate2", "Continue", "Avatar", "Wan"]) {
            expect(labels).toContain(need);
        }
        expect(localMarketFeaturedAppIds()).toContain("h3-t2v");
        expect(localMarketFeaturedAppIds()).toContain("vace-edit");
        expect(localMarketFeaturedAppIds()).toContain("avatar-talk");
    });

    test("resolveLocalCapabilityBadge maps keepers to worker/engine", () => {
        expect(resolveLocalCapabilityBadge({ id: "h3-t2v" })?.worker).toBe(":8264");
        expect(resolveLocalCapabilityBadge({ id: "h3-i2v" })?.engine).toBe("H3");
        expect(resolveLocalCapabilityBadge({ id: "longcat-t2v" })?.worker).toBe(":8197");
        expect(resolveLocalCapabilityBadge({ id: "longcat-continue" })?.engine).toBe("Continue");
        expect(resolveLocalCapabilityBadge({ id: "wan-animate-2" })?.worker).toBe(":8199");
        expect(resolveLocalCapabilityBadge({ id: "vace-edit" })?.engine).toBe("VACE");
        expect(resolveLocalCapabilityBadge({ id: "avatar-talk" })?.engine).toBe("Avatar");
        expect(resolveLocalCapabilityBadge({ id: "rh-acc-123" })).toBeNull();
    });

    test("create presets: image + h3 + 6 video engines", () => {
        expect(LOCAL_CREATE_PRESETS).toHaveLength(8);
        expect(LOCAL_CREATE_PRESETS.filter((p) => p.protocol === "toiv-comfy-image")).toHaveLength(1);
        expect(LOCAL_CREATE_PRESETS.filter((p) => p.protocol === "toiv-h3")).toHaveLength(1);
        expect(LOCAL_CREATE_PRESETS.filter((p) => p.protocol === "toiv-comfy-video")).toHaveLength(6);
        expect(LOCAL_CREATE_PRESETS.find((p) => p.protocol === "toiv-comfy-image")?.modelRef).toBe(LOCAL_IMAGE_MODEL_REF);
        expect(LOCAL_CREATE_PRESETS.find((p) => p.protocol === "toiv-h3")?.modelRef).toBe(LOCAL_H3_MODEL_REF);
        expect(LOCAL_CREATE_PRESETS.every((p) => p.modelRef.includes("::"))).toBe(true);
        expect(LOCAL_CREATE_PRESETS.some((p) => p.modelRef.startsWith(LOCAL_VIDEO_CHANNEL_ID + "::"))).toBe(true);
    });

    test("home intent bar covers intentMap keepers → /toiv/market?app=", () => {
        expect(HOME_INTENT_ENTRIES).toHaveLength(20);
        for (const entry of HOME_INTENT_ENTRIES) {
            expect(entry.to).toBe(`/toiv/market?app=${entry.appId}`);
            expect(entry.appId.length).toBeGreaterThan(0);
            expect(entry.label.length).toBeGreaterThan(0);
        }
        expect(HOME_INTENT_MARKET_LINKS.lipsync.to).toStartWith("/toiv/market?app=");
        expect(HOME_INTENT_MARKET_LINKS.dub.to).toContain("h3-r2v-voice");
        expect(HOME_INTENT_MARKET_LINKS.voice.appId).toBe("h3-r2v-voice");
        expect(HOME_INTENT_MARKET_LINKS.inpaint.to).toContain("rh-acc-1967241218-76fc32");
        expect(HOME_INTENT_MARKET_LINKS.outfit.appId).toBe("rh-acc-3051342849-5d0a1c");
        expect(HOME_INTENT_MARKET_LINKS["3d"].appId).toBe("rh-acc-1922543617-0d4e78");
    });

    test("home intent keepers align with apps/web intentMap.ts", () => {
        const intentMap = readFileSync(join(import.meta.dir, "../../../web/lib/intentMap.ts"), "utf8");
        for (const entry of HOME_INTENT_ENTRIES) {
            expect(intentMap).toContain(`id: "${entry.id}"`);
            expect(intentMap).toContain(`appId: "${entry.appId}"`);
            expect(intentMap).toContain(`label: "${entry.label}"`);
        }
    });

    test("sortAppsWithFeaturedIds pins known ids first", () => {
        const apps = [{ id: "z" }, { id: "h3-t2v" }, { id: "a" }, { id: "vace-edit" }];
        const sorted = sortAppsWithFeaturedIds(apps, ["h3-t2v", "vace-edit"]);
        expect(sorted.map((a) => a.id)).toEqual(["h3-t2v", "vace-edit", "z", "a"]);
    });
});

describe("local-capability-surface wiring (source)", () => {
    const market = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
    const home = readFileSync(join(import.meta.dir, "../src/pages/home/home-data.ts"), "utf8");
    const dashboard = readFileSync(join(import.meta.dir, "../src/pages/home/home-dashboard.tsx"), "utf8");
    const menu = readFileSync(join(import.meta.dir, "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools.tsx"), "utf8");
    const client = readFileSync(join(import.meta.dir, "../src/services/toiv/client.ts"), "utf8");

    test("market page shows local badges, featured strip, and variants modes", () => {
        expect(market).toContain("LOCAL_MARKET_FEATURED");
        expect(market).toContain("LocalBadges");
        expect(market).toContain("fetchToivAppVariants");
        expect(market).toContain("本地精选");
        expect(market).toContain("resolveLocalCapabilityBadge");
    });

    test("home intent bar deep-links market keepers (no empty-shell add=)", () => {
        expect(home).toContain("HOME_INTENT_ENTRIES");
        expect(home).toContain("homeIntentBarItems");
        expect(dashboard).toContain("homeIntentBarItems");
        expect(dashboard).toContain("toiv-intent-bar");
        expect(dashboard).toContain("toiv-intent-chip");
        expect(home).not.toContain("add=lipsync");
        expect(home).not.toContain("add=inpaint");
        expect(home).not.toContain("add=dub");
        // 意图已从核心能力卡拆出，避免与意图条重复
        expect(home).not.toContain("HOME_INTENT_MARKET_LINKS.lipsync.to");
    });

    test("create-menu registers hardcoded local presets", () => {
        expect(menu).toContain("LOCAL_CREATE_PRESETS");
        expect(menu).toContain("onAddLocalGenerator");
        expect(menu).toContain("preset.modelRef");
        expect(menu).toContain("toiv-comfy-image / toiv-h3 / toiv-comfy-video");
    });

    test("client exposes variants fetch", () => {
        expect(client).toContain("fetchToivAppVariants");
        expect(client).toContain("/variants");
        expect(client).toContain("submit_kind?");
    });
});
