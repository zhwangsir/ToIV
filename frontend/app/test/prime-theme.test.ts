import { afterEach, describe, expect, test } from "bun:test";
import {
    DEFAULT_THEME, THEMES, THEME_IDS, THEME_TOKEN_KEYS, contrastRatio,
} from "../src/toiv/theme/tokens";
import {
    OVERRIDES_KEY, THEME_KEY, applyStoredTheme, applyThemeTo, readThemeState, resolveTokens,
    sanitizeOverrides, sanitizeThemeId, saveThemeState,
} from "../src/toiv/theme/apply";

const memory = new Map<string, string>();
const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage() {
    memory.clear();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => memory.get(key) ?? null,
            setItem: (key: string, value: string) => { memory.set(key, value); },
            removeItem: (key: string) => { memory.delete(key); },
            clear: () => memory.clear(),
        },
    });
}

function fakeRoot() {
    const values = new Map<string, string>();
    return {
        values,
        root: {
            dataset: {} as Record<string, string>,
            style: {
                colorScheme: "",
                setProperty(key: string, value: string) { values.set(key, value); },
                removeProperty(key: string) { values.delete(key); },
                getPropertyValue(key: string) { return values.get(key) ?? ""; },
            },
        },
    };
}

afterEach(() => {
    if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("prime theme palette", () => {
    test("ships four complete palettes with light as the default", () => {
        expect(THEME_IDS).toEqual(["light", "aurora", "black", "cyber"]);
        expect(DEFAULT_THEME).toBe("light");
        const names = THEME_IDS.map((id) => THEMES[id].name);
        expect(new Set(names).size).toBe(4);
        for (const id of THEME_IDS) {
            expect(THEMES[id].id).toBe(id);
            expect(THEMES[id].name.length).toBeGreaterThan(0);
            expect(THEMES[id].description.length).toBeGreaterThan(0);
            for (const key of THEME_TOKEN_KEYS) {
                expect(THEMES[id].tokens[key].trim().length).toBeGreaterThan(0);
            }
        }
    });

    test("keeps ink and secondary text readable on every background", () => {
        for (const id of THEME_IDS) {
            const tokens = THEMES[id].tokens;
            expect(contrastRatio(tokens["--pf-ink"], tokens["--pf-bg"])).toBeGreaterThanOrEqual(7);
            expect(contrastRatio(tokens["--text-secondary"], tokens["--pf-bg"])).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(tokens["--pf-muted"], tokens["--pf-bg"])).toBeGreaterThanOrEqual(4.5);
        }
    });

    test("computes WCAG contrast ratios and rejects malformed colours", () => {
        expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
        expect(contrastRatio("#fff", "#ffffff")).toBe(1);
        expect(contrastRatio("rebeccapurple", "#ffffff")).toBe(1);
    });

    test("falls back to the light theme for unknown ids", () => {
        expect(sanitizeThemeId("neon")).toBe("light");
        expect(sanitizeThemeId(null)).toBe("light");
        expect(sanitizeThemeId("cyber")).toBe("cyber");
    });

    test("keeps only known theme token overrides with valid colours", () => {
        const clean = sanitizeOverrides({
            aurora: { "--pf-lime": "#00ffcc", "--evil": "#ffffff" },
            nope: { "--pf-bg": "#000000" },
            cyber: { "--pf-bg": "rgb(0,0,0)" },
        });
        expect(clean).toEqual({ aurora: { "--pf-lime": "#00ffcc" } });
        expect(sanitizeOverrides("junk")).toEqual({});
        expect(sanitizeOverrides({ light: null })).toEqual({});
    });

    test("resolves overrides over the palette without mutating other tokens", () => {
        const tokens = resolveTokens("light", { light: { "--pf-lime": "#123456" } });
        expect(tokens["--pf-lime"]).toBe("#123456");
        expect(tokens["--pf-bg"]).toBe(THEMES.light.tokens["--pf-bg"]);
        const untouched = resolveTokens("aurora", { light: { "--pf-lime": "#123456" } });
        expect(untouched["--pf-lime"]).toBe(THEMES.aurora.tokens["--pf-lime"]);
    });

    test("persists theme choice and overrides and recovers from bad storage", () => {
        installStorage();
        saveThemeState("aurora", { aurora: { "--pf-bg": "#010203" } });
        expect(memory.get(THEME_KEY)).toBe("aurora");
        expect(JSON.parse(memory.get(OVERRIDES_KEY)!)).toEqual({ aurora: { "--pf-bg": "#010203" } });
        expect(readThemeState()).toEqual({ theme: "aurora", overrides: { aurora: { "--pf-bg": "#010203" } } });
        saveThemeState("aurora", {});
        expect(memory.has(OVERRIDES_KEY)).toBe(false);
        memory.set(OVERRIDES_KEY, "{broken");
        expect(readThemeState().overrides).toEqual({});
        memory.set(THEME_KEY, "neon");
        expect(readThemeState().theme).toBe("light");
    });

    test("applies the palette to a root element and clears stale inline overrides", () => {
        const { root, values } = fakeRoot();
        applyThemeTo(root as unknown as HTMLElement, "cyber", { cyber: { "--pf-lime": "#00ffcc" } });
        expect(root.dataset.theme).toBe("cyber");
        expect(root.style.colorScheme).toBe("dark");
        expect(values.get("--pf-lime")).toBe("#00ffcc");
        expect(values.has("--pf-bg")).toBe(false);
        applyThemeTo(root as unknown as HTMLElement, "light", { cyber: { "--pf-lime": "#00ffcc" } });
        expect(root.dataset.theme).toBe("light");
        expect(root.style.colorScheme).toBe("light");
        expect(values.has("--pf-lime")).toBe(false);
    });

    test("bootstraps the stored theme without a document", () => {
        installStorage();
        saveThemeState("black", {});
        expect(applyStoredTheme()).toBe("black");
    });
});
