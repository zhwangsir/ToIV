/** R18 门控模式(D-U1)单测:开关持久化 + dataset 钩子 + 头开关(不碰 axios)。 */
import { describe, expect, test } from "bun:test";

function installBrowserStub(r18: string | null) {
    const store = new Map<string, string | null>([["toiv_r18_mode", r18]]);
    (globalThis as Record<string, unknown>).window = {
        localStorage: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        },
    };
    const dataset: Record<string, string> = {};
    (globalThis as Record<string, unknown>).document = { documentElement: { dataset } };
    return { store, dataset };
}

describe("r18-mode", () => {
    test("setR18Mode 持久化并反映到 html dataset;nsfwHeaderEnabled 跟随", () => {
        const { dataset } = installBrowserStub(null);
        const mod = require("../src/services/toiv/r18-mode");
        expect(mod.isR18Mode()).toBe(false);
        expect(mod.nsfwHeaderEnabled()).toBe(false);
        mod.setR18Mode(true);
        expect(mod.isR18Mode()).toBe(true);
        expect(mod.nsfwHeaderEnabled()).toBe(true);
        expect(dataset.r18).toBe("1");
        mod.setR18Mode(false);
        expect(mod.isR18Mode()).toBe(false);
        expect(mod.nsfwHeaderEnabled()).toBe(false);
        expect(dataset.r18).toBeUndefined();
    });

    test("预置 toiv_r18_mode=1 时 initR18Mode 恢复 dataset(启动路径)", () => {
        const { dataset } = installBrowserStub("1");
        const mod = require("../src/services/toiv/r18-mode");
        mod.initR18Mode();
        expect(dataset.r18).toBe("1");
        expect(mod.nsfwHeaderEnabled()).toBe(true);
    });
});
