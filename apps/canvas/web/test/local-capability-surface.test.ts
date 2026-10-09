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
import {
    INTENT_ENTRIES,
    resolveIntentAppId,
} from "../../../web/lib/intentKeepers";

describe("local-capability-surface catalog", () => {
    test("featured pack covers local 7 + Wan", () => {
        const labels = LOCAL_MARKET_FEATURED.map((e) => e.label);
        for (const need of ["本地出图", "H3", "LongCat", "VACE", "Animate2", "Continue", "Avatar", "Wan"]) {
            expect(labels).toContain(need);
        }
        expect(localMarketFeaturedAppIds()).toContain("h3-t2v");
        expect(localMarketFeaturedAppIds()).toContain("vace-edit");
        expect(localMarketFeaturedAppIds()).toContain("avatar-talk");
        expect(localMarketFeaturedAppIds()).toContain("longcat-continue");
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

    test("home intent bar is single-sourced from intentKeepers with local-first app ids", () => {
        expect(HOME_INTENT_ENTRIES).toHaveLength(INTENT_ENTRIES.length);
        expect(HOME_INTENT_ENTRIES.length).toBeGreaterThanOrEqual(21);
        for (let i = 0; i < INTENT_ENTRIES.length; i++) {
            const src = INTENT_ENTRIES[i];
            const home = HOME_INTENT_ENTRIES[i];
            expect(home.id).toBe(src.id);
            expect(home.label).toBe(src.label);
            expect(home.appId).toBe(resolveIntentAppId(src));
            expect(home.to).toBe(`/toiv/market?app=${encodeURIComponent(resolveIntentAppId(src))}`);
        }
        // 对口型 / 数字人分轨
        expect(HOME_INTENT_MARKET_LINKS.lipsync.appId).toBe("ovi-i2v");
        expect(HOME_INTENT_MARKET_LINKS.avatar.appId).toBe("avatar-talk");
        expect(HOME_INTENT_MARKET_LINKS.i2v.appId).toBe("h3-i2v");
        expect(HOME_INTENT_MARKET_LINKS.t2v.appId).toBe("h3-t2v");
        // 放大：alt 是 RH，应保留本地 upscale
        expect(HOME_INTENT_MARKET_LINKS.upscale.appId).toBe("upscale");
        expect(HOME_INTENT_MARKET_LINKS.dub.appId).toBe("h3-r2v-voice");
        expect(HOME_INTENT_MARKET_LINKS.inpaint.to).toContain("rh-acc-1967241218-76fc32");
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
    const surface = readFileSync(join(import.meta.dir, "../src/services/toiv/local-capability-surface.ts"), "utf8");
    const menu = readFileSync(join(import.meta.dir, "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools.tsx"), "utf8");
    const client = readFileSync(join(import.meta.dir, "../src/services/toiv/client.ts"), "utf8");
    const avatarTalk = readFileSync(join(import.meta.dir, "../../../web/components/avatartalk/AvatarTalkView.tsx"), "utf8");
    const seed = readFileSync(join(import.meta.dir, "../../../api/app/services/app_seed.py"), "utf8");

    test("market page shows local badges, featured strip, and variants modes", () => {
        expect(market).toContain("LOCAL_MARKET_FEATURED");
        expect(market).toContain("LocalBadges");
        expect(market).toContain("fetchToivAppVariants");
        expect(market).toContain("本地精选");
        expect(market).toContain("resolveLocalCapabilityBadge");
    });

    test("home intent bar deep-links market keepers from intentKeepers (no empty-shell add=)", () => {
        expect(surface).toContain("@toiv-web/lib/intentKeepers");
        expect(surface).toContain("resolveIntentAppId");
        expect(home).toContain("HOME_INTENT_ENTRIES");
        expect(home).toContain("homeIntentBarItems");
        expect(dashboard).toContain("homeIntentBarItems");
        expect(dashboard).toContain("toiv-intent-bar");
        expect(home).not.toContain("add=lipsync");
        expect(home).not.toContain("add=inpaint");
        expect(home).not.toContain("add=dub");
    });

    test("P0-1 longcat-continue is seeded builtin (no ghost featured)", () => {
        expect(seed).toContain('"longcat-continue"');
        expect(seed).toContain("LongCat 视频续写");
        expect(LOCAL_MARKET_FEATURED.find((e) => e.id === "local-continue")?.appId).toBe("longcat-continue");
    });

    test("P0-3 AvatarTalkView gen deep-links avatar-talk (split from lipsync)", () => {
        expect(avatarTalk).toContain('market?app=avatar-talk');
        expect(avatarTalk).toContain("打开数字人应用");
        expect(avatarTalk).toContain("与对口型分轨");
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
