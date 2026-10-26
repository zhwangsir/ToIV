/** 前端红线 SSOT + 路由守卫判定（后端不 403）。 */
import { describe, expect, test } from "bun:test";

function installBrowserStub(r18: string | null, birthdate: string | null = null) {
    const store = new Map<string, string | null>([
        ["toiv_r18_mode", r18],
        ["toiv_birthdate", birthdate],
    ]);
    (globalThis as Record<string, unknown>).window = {
        localStorage: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        },
        location: { href: "http://localhost/", pathname: "/", search: "", assign() {}, replace() {} },
        dispatchEvent: () => true,
        addEventListener() {},
        removeEventListener() {},
        setInterval: () => 0,
        clearInterval() {},
    };
    const dataset: Record<string, string> = {};
    (globalThis as Record<string, unknown>).document = { documentElement: { dataset } };
    return { store, dataset };
}

describe("redline guard", () => {
    test("default SFW; setR18Mode toggles header + dataset", () => {
        const { dataset } = installBrowserStub(null);
        const id = require.resolve("../src/redline");
        delete require.cache[id];
        const mod = require("../src/redline");
        expect(mod.isR18Mode()).toBe(false);
        expect(mod.nsfwHeaderEnabled()).toBe(false);
        expect(mod.setR18Mode(true)).toBe(true);
        expect(mod.isR18Mode()).toBe(true);
        expect(dataset.r18).toBe("1");
        mod.setR18Mode(false);
        expect(mod.nsfwHeaderEnabled()).toBe(false);
    });

    test("underage blocks enable even if storage was on", () => {
        installBrowserStub("1", "2015-01-01");
        const id = require.resolve("../src/redline");
        delete require.cache[id];
        const mod = require("../src/redline");
        expect(mod.isUnderage()).toBe(true);
        expect(mod.isR18Mode()).toBe(false);
        expect(mod.setR18Mode(true)).toBe(false);
        expect(mod.nsfwHeaderEnabled()).toBe(false);
    });

    test("gated query/path redirects when R18 off; settings focus=r18 never gated", () => {
        installBrowserStub(null);
        const id = require.resolve("../src/redline");
        delete require.cache[id];
        const mod = require("../src/redline");
        expect(mod.r18GuardRedirect({ pathname: "/toiv/market", search: "?category=r18" })).toBe(
            mod.R18_SETTINGS_GATE_PATH,
        );
        expect(mod.r18GuardRedirect({ pathname: "/toiv/market", search: "?app=wan-nsfw-i2v" })).toBe(
            mod.R18_SETTINGS_GATE_PATH,
        );
        expect(mod.r18GuardRedirect({ pathname: "/nsfw", search: "" })).toBe(mod.R18_SETTINGS_GATE_PATH);
        expect(mod.r18GuardRedirect({ pathname: "/settings", search: "?focus=r18" })).toBeNull();
        expect(mod.r18GuardRedirect({ pathname: "/toiv/market", search: "" })).toBeNull();
        mod.setR18Mode(true);
        expect(mod.r18GuardRedirect({ pathname: "/toiv/market", search: "?category=r18" })).toBeNull();
    });

    test("r18-mode thin re-export matches redline", () => {
        installBrowserStub(null);
        delete require.cache[require.resolve("../src/redline")];
        delete require.cache[require.resolve("../src/services/toiv/r18-mode")];
        const a = require("../src/redline");
        const b = require("../src/services/toiv/r18-mode");
        expect(b.isR18Mode).toBe(a.isR18Mode);
        expect(b.nsfwHeaderEnabled).toBe(a.nsfwHeaderEnabled);
    });

    test("Wire copy uses 普通/成人; CTA points at settings gate; account-global copy", () => {
        installBrowserStub(null);
        const id = require.resolve("../src/redline");
        delete require.cache[id];
        const mod = require("../src/redline");
        expect(mod.COPY_MODE_NORMAL).toBe("普通");
        expect(mod.COPY_MODE_ADULT).toBe("成人");
        expect(mod.COPY_GUARD_REASON).toContain("普通模式");
        expect(mod.COPY_GUARD_REASON).toContain("成人模式");
        expect(mod.COPY_SWITCH_TO_ADULT).toBe("切换到成人模式");
        expect(mod.COPY_STAY_NORMAL).toBe("留在普通内容");
        expect(mod.COPY_CONFIRM_SWITCH).toContain("确认切换");
        expect(mod.COPY_ACCOUNT_GLOBAL).toContain("所有设备");
        expect(mod.R18_SETTINGS_GATE_PATH).toContain("focus=r18");
        expect(mod.MODE_SWITCH_DOES_NOT_ABORT_INFLIGHT).toBe(true);
        expect(mod.ACCOUNT_MODE_POLL_MS).toBe(30_000);
    });
});

describe("redline NSFW asset visibility", () => {
    test("known NSFW listable but not selectable in 普通; unknown hidden", () => {
        installBrowserStub(null);
        const id = require.resolve("../src/redline");
        delete require.cache[id];
        const mod = require("../src/redline");
        expect(mod.isNsfwAssetMarker("wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors")).toBe(true);
        expect(mod.isNsfwAssetMarker("wan2.2-rapid-mega-aio-v12.safetensors")).toBe(false);
        expect(mod.isNsfwAssetMarker("Qwen-Rapid-AIO-SFW-v23.safetensors")).toBe(false);
        expect(mod.assetLooksNsfw({ nsfw: true, basename: "foo.safetensors" })).toBe(true);
        expect(mod.classifyAssetContent({ is_nsfw: true, basename: "clean.safetensors" })).toBe("nsfw");
        expect(mod.classifyAssetContent({ content_rating: "unknown" })).toBe("unknown");
        // 已知 NSFW：列表可见、不可选
        expect(mod.isNsfwAssetListable("wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors")).toBe(true);
        expect(mod.isNsfwAssetSelectable("wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors")).toBe(false);
        expect(mod.isNsfwAssetVisible("wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors")).toBe(false); // alias=selectable
        const list = mod.filterNsfwListableAssets([
            "wan2.2-rapid-mega-aio-v12.safetensors",
            "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors",
        ]);
        expect(list).toEqual([
            "wan2.2-rapid-mega-aio-v12.safetensors",
            "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors",
        ]);
        // 未知：普通藏
        expect(mod.isNsfwAssetListable({ content_rating: "unknown", basename: "x.safetensors" })).toBe(false);
        expect(
            mod.visibleSelectionOrFallback(
                "wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors",
                "Qwen-Rapid-AIO-SFW-v23.safetensors",
            ),
        ).toBe("Qwen-Rapid-AIO-SFW-v23.safetensors");
        mod.setR18Mode(true);
        expect(mod.isNsfwAssetSelectable("wan2.2-rapid-mega-aio-nsfw-v12.2.safetensors")).toBe(true);
        expect(mod.isNsfwAssetListable({ content_rating: "unknown" })).toBe(true);
        expect(mod.filterNsfwListableAssets(["a-nsfw-b.safetensors", "ok.safetensors"]).length).toBe(2);
        expect(mod.shouldApplyContentSoftening()).toBe(false);
        mod.setR18Mode(false);
        expect(mod.shouldApplyContentSoftening()).toBe(true);
    });

    test("explicit metadata beats filename; fallback tip on switch to 普通", () => {
        installBrowserStub("1");
        const id = require.resolve("../src/redline");
        delete require.cache[id];
        const mod = require("../src/redline");
        expect(mod.classifyAssetContent({ is_nsfw: false, basename: "foo-nsfw-bar.safetensors" })).toBe("sfw");
        expect(mod.classifyAssetContent({ is_nsfw: true, basename: "clean.safetensors" })).toBe("nsfw");
        expect(mod.isR18Mode()).toBe(true);
        mod.setR18Mode(false);
        expect(mod.peekFallbackTip()).toBe(true);
        expect(mod.consumeFallbackTip()).toBe(true);
        expect(mod.consumeFallbackTip()).toBe(false);
        expect(mod.FALLBACK_IMAGE_BASENAME).toContain("Qwen-Rapid-AIO-SFW-v23");
        expect(mod.FALLBACK_VIDEO_MODEL).toBe("local-wan");
    });
});
