import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
    ADD_NODE_MENU_CREATIVE_LABELS,
    HOME_INTENT_ENTRIES,
    HOME_INTENT_MARKET_LINKS,
    LOCAL_CREATE_PRESETS,
    LOCAL_H3_MODEL_REF,
    LOCAL_MARKET_FEATURED,
    defaultLocalImagePreset,
    defaultLocalVideoPreset,
    localMarketFeaturedAppIds,
    localVideoEnginePresets,
    resolveLocalCapabilityBadge,
    sortAppsDemotingIds,
    sortAppsWithFeaturedIds,
    sortMarketAppsDefault,
} from "../src/services/toiv/local-capability-surface";
import { LOCAL_IMAGE_MODEL_REF, LOCAL_VIDEO_CHANNEL_ID } from "../src/lib/local-model-defaults";
import {
    INTENT_ENTRIES,
    resolveIntentAppId,
} from "../src/services/toiv/intent-keepers";

describe("local-capability-surface catalog", () => {
    test("featured pack covers local 7 + Wan with creative labels", () => {
        const labels = LOCAL_MARKET_FEATURED.map((e) => e.label);
        for (const need of ["图像", "短剧视频", "长视频", "视频编辑", "动作视频", "视频续写", "数字人", "视频生成"]) {
            expect(labels).toContain(need);
        }
        expect(labels.some((l) => l.includes("本地·"))).toBe(false);
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

    test("sortAppsDemotingIds / sortMarketAppsDefault demote RH i2v/t2v only", () => {
        const apps = [
            { id: "rh-acc-1833790465-924e7f" },
            { id: "h3-i2v" },
            { id: "rh-acc-8490907650-9066b5" },
            { id: "txt2img-basic" },
        ];
        const demoted = sortAppsDemotingIds(apps, [
            "rh-acc-1833790465-924e7f",
            "rh-acc-8490907650-9066b5",
        ]);
        expect(demoted.map((a) => a.id).slice(0, 2)).toEqual(["h3-i2v", "txt2img-basic"]);
        const sorted = sortMarketAppsDefault([
            { id: "rh-acc-1833790465-924e7f" },
            { id: "plain" },
            { id: "h3-t2v" },
            { id: "rh-acc-8490907650-9066b5" },
        ]);
        expect(sorted[0].id).toBe("h3-t2v");
        expect(sorted.map((a) => a.id).slice(-2).sort()).toEqual(
            ["rh-acc-1833790465-924e7f", "rh-acc-8490907650-9066b5"].sort(),
        );
    });

    test("home intent resolve: t2i→txt2img-basic; upscale→upscale (Slice A)", () => {
        const t2i = INTENT_ENTRIES.find((e) => e.id === "t2i");
        const upscale = INTENT_ENTRIES.find((e) => e.id === "upscale");
        expect(t2i && resolveIntentAppId(t2i)).toBe("txt2img-basic");
        expect(upscale && resolveIntentAppId(upscale)).toBe("upscale");
        expect(upscale?.altAppId).toBeUndefined();
        const homeT2i = HOME_INTENT_ENTRIES.find((e) => e.id === "t2i");
        expect(homeT2i?.appId).toBe("txt2img-basic");
        expect(homeT2i?.to).toContain("txt2img-basic");
    });

});

describe("local-capability-surface wiring (source)", () => {
    const market = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
    const home = readFileSync(join(import.meta.dir, "../src/pages/home/home-data.ts"), "utf8");
    const dashboard = readFileSync(join(import.meta.dir, "../src/pages/home/home-dashboard.tsx"), "utf8");
    const surface = readFileSync(join(import.meta.dir, "../src/services/toiv/local-capability-surface.ts"), "utf8");
    const menu = readFileSync(join(import.meta.dir, "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools.tsx"), "utf8");
    const client = readFileSync(join(import.meta.dir, "../src/services/toiv/client.ts"), "utf8");
    const seed = readFileSync(join(import.meta.dir, "../../../api/app/services/app_seed.py"), "utf8");

    test("market page shows local badges, featured strip, and variants modes", () => {
        expect(market).toContain("LOCAL_MARKET_FEATURED");
        expect(market).toContain("LocalBadges");
        expect(market).toContain("fetchToivAppVariants");
        expect(market).toContain("本地精选");
        expect(market).toContain("resolveLocalCapabilityBadge");
        // Wave P1 / G10: 产品面不渲染 worker 端口徽章
        expect(market).not.toContain("label={badge.worker}");
        expect(market).toContain("localCapabilityProductLabel");
    });

    test("home intent bar deep-links market keepers from intentKeepers (no empty-shell add=)", () => {
        expect(surface).toContain('from "./intent-keepers"');
        expect(surface).toContain("resolveIntentAppId");
        expect(home).toContain("HOME_INTENT_ENTRIES");
        expect(home).toContain("homeIntentBarItems");
        // BF0：意图条仅 export（工具台/市场后用），首页禁止 import/map 意图墙
        expect(dashboard).not.toMatch(/import\s*\{[^}]*homeIntentBarItems/);
        expect(dashboard).not.toContain("homeIntentBarItems.map");
        const market = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
        expect(market).toContain("ToolsIntentGrid");
        const grid = readFileSync(join(import.meta.dir, "../src/components/toiv/tools-intent-grid.tsx"), "utf8");
        expect(grid).toContain("homeIntentBarItems");
        expect(grid).toContain("INTENT_TOOL_GROUPS");
        expect(dashboard).toContain("beefTVCapabilityItems");
        expect(dashboard).toContain("打开创作台");
        expect(dashboard).not.toContain("/canvas?mode=new");
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
        // F12/U1:web 数字面已退役下架,canvas 市场保留 avatar-talk 深链目标即可
        expect(existsSync(join(import.meta.dir, "../../../web/components/avatartalk/AvatarTalkView.tsx"))).toBe(false);
        expect(surface).toContain('appId: "avatar-talk"');
    });

    test("create-menu uses creative primary labels and defaults to H3 video", () => {
        expect(menu).toContain("defaultLocalImagePreset");
        expect(menu).toContain("defaultLocalVideoPreset");
        expect(menu).toContain("onAddLocalGenerator");
        expect(menu).toContain('label: "图像"');
        expect(menu).toContain('label: "视频"');
        expect(menu).toContain('label: "合成"');
        expect(menu).toContain('label: "分组"');
        expect(menu).not.toContain("LOCAL_CREATE_PRESETS.map");
        expect(menu).not.toContain("本地·H3");
        expect(menu).not.toContain("本地·Wan");
        expect(menu).not.toContain(":8264");
    });

    test("client exposes variants fetch", () => {
        expect(client).toContain("fetchToivAppVariants");
        expect(client).toContain("/variants");
        expect(client).toContain("submit_kind?");
    });

    test("Wave P3 / D3-A: create/featured labels are creative semantics (not 本地·引擎)", () => {
        for (const e of LOCAL_MARKET_FEATURED) {
            expect(e.label.startsWith("本地·")).toBe(false);
            expect(e.label).not.toMatch(/:\d{4}/);
        }
        for (const e of LOCAL_CREATE_PRESETS) {
            expect(e.label.startsWith("本地·")).toBe(false);
            expect(e.label).not.toMatch(/:\d{4}/);
        }
        expect(defaultLocalVideoPreset().protocol).toBe("toiv-h3");
        expect(defaultLocalVideoPreset().modelRef).toBe(LOCAL_H3_MODEL_REF);
        expect(defaultLocalImagePreset().protocol).toBe("toiv-comfy-image");
        expect(localVideoEnginePresets().length).toBe(7);
        expect(ADD_NODE_MENU_CREATIVE_LABELS).toEqual(["文本", "图像", "视频", "音频", "合成", "分组"]);
    });
});
