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
    };
    const dataset: Record<string, string> = {};
    (globalThis as Record<string, unknown>).document = { documentElement: { dataset } };
    return { store, dataset };
}

describe("redline guard", () => {
    test("default SFW; setR18Mode toggles header + dataset", () => {
        const { dataset } = installBrowserStub(null);
        // fresh module each time via require cache bust
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
});

    test("Wire copy uses 普通/成人; CTA points at settings gate", () => {
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
        expect(mod.R18_SETTINGS_GATE_PATH).toContain("focus=r18");
    });
