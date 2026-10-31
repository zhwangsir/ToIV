import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    buildDefaultRunValues,
    buildToivRunValues,
    normalizeToivAppParam,
    requiredToivParamLabel,
    type ToivAppParam,
} from "../src/services/toiv/market-run";
import {
    isMarketCanvasProvider,
    listMarketCanvasProviders,
    registerMarketCanvasProvider,
    unregisterMarketCanvasProvider,
} from "../src/services/toiv/market-providers";

const SCHEMA: ToivAppParam[] = [
    normalizeToivAppParam({ key: "prompt", label: "提示词", type: "textarea", default: null }),
    normalizeToivAppParam({ key: "steps", label: "步数", type: "number", default: 20 }),
    normalizeToivAppParam({ key: "mode", label: "模式", type: "select", default: "a", options: [{ value: "a", label: "A" }] }),
    normalizeToivAppParam({ key: "hires", label: "高清", type: "switch", default: false }),
    normalizeToivAppParam({ key: "ref", label: "参考图", type: "images", default: null, required: true }),
];

function installMemoryLocalStorage() {
    const store = new Map<string, string>();
    const ls = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
            store.set(k, String(v));
        },
        removeItem: (k: string) => {
            store.delete(k);
        },
        clear: () => store.clear(),
    };
    Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true });
    Object.defineProperty(globalThis, "window", {
        value: { localStorage: ls },
        configurable: true,
    });
}

describe("toiv market M2 pure helpers", () => {
    test("buildDefaultRunValues fills defaults and empty media", () => {
        const v = buildDefaultRunValues(SCHEMA);
        expect(v.prompt).toBe("");
        expect(v.steps).toBe(20);
        expect(v.mode).toBe("a");
        expect(v.hires).toBe(false);
        expect(v.ref).toEqual([]);
    });

    test("requiredToivParamLabel gaps on null-default text and empty media", () => {
        const v = buildDefaultRunValues(SCHEMA);
        expect(requiredToivParamLabel(SCHEMA, v)).toBe("提示词");
        v.prompt = "一只猫";
        expect(requiredToivParamLabel(SCHEMA, v)).toBe("参考图");
        v.ref = ["file.png"];
        expect(requiredToivParamLabel(SCHEMA, v)).toBeNull();
    });

    test("buildToivRunValues normalizes number/switch/text", () => {
        const out = buildToivRunValues(SCHEMA, {
            prompt: "hello",
            steps: "12",
            mode: "a",
            hires: 1,
            ref: ["a.png"],
        });
        expect(out).toEqual({
            prompt: "hello",
            steps: 12,
            mode: "a",
            hires: true,
            ref: ["a.png"],
        });
    });

    test("market-providers registry is idempotent", () => {
        installMemoryLocalStorage();
        expect(listMarketCanvasProviders()).toEqual([]);
        registerMarketCanvasProvider({ id: "app-1", name: "测应用", category: "image" });
        expect(isMarketCanvasProvider("app-1")).toBe(true);
        registerMarketCanvasProvider({ id: "app-1", name: "测应用改名", category: "video" });
        const list = listMarketCanvasProviders();
        expect(list).toHaveLength(1);
        expect(list[0]?.name).toBe("测应用改名");
        expect(list[0]?.category).toBe("video");
        expect(unregisterMarketCanvasProvider("app-1")).toBe(true);
        expect(isMarketCanvasProvider("app-1")).toBe(false);
    });
});

describe("toiv market M2 page contracts (source)", () => {
    const page = readFileSync(join(import.meta.dir, "../src/pages/toiv/market-page.tsx"), "utf8");
    const client = readFileSync(join(import.meta.dir, "../src/services/toiv/client.ts"), "utf8");
    const sidebar = readFileSync(
        join(import.meta.dir, "../src/components/layout/workspace-sidebar-nav.tsx"),
        "utf8",
    );

    test("market page runs via API and navigates to tasks (no classic jump)", () => {
        expect(page).toContain("runToivApp");
        expect(page).toContain('navigate(`/toiv/tasks?from=market&job=');
        expect(page).not.toContain("classic=1");
        expect(page).not.toContain("?view=market");
        expect(page).toContain("注册到画布");
        expect(page).toContain("运行此应用");
    });

    test("client exposes detail + run endpoints", () => {
        expect(client).toContain('toivHttp.get(`/apps/${encodeURIComponent(id)}`)');
        expect(client).toContain('toivHttp.post(`/apps/${encodeURIComponent(id)}/run`');
        expect(client).toContain("buildToivRunValues");
        expect(client).toContain("requiredToivParamLabel");
    });

    test("sidebar market is internal /toiv/market", () => {
        expect(sidebar).toContain('to: "/toiv/market"');
        expect(sidebar).not.toMatch(/toiv:market[\s\S]{0,120}external/);
    });
});
