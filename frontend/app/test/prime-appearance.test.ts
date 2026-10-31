import { afterEach, describe, expect, test } from "bun:test";
import { THEMES, formatColor, isCssColor, parseColor } from "../src/toiv/theme/tokens";
import { OVERRIDES_KEY, THEME_KEY } from "../src/toiv/theme/apply";
import {
    APPEARANCE_KEY, DEFAULT_LAYOUT, MAX_CUSTOM_THEMES,
    applyAppearanceTo, applyLayoutTo, applyStoredAppearance, createCustomTheme, defaultAppearance,
    deleteCustomTheme, editActiveToken, exportAppearance, importAppearance, readAppearance,
    renameCustomTheme, resetActiveTokens, resolveTheme, sanitizeAppearance, sanitizeLayout,
    saveAppearance, selectTheme,
} from "../src/toiv/theme/appearance";

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
                fontSize: "",
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

describe("appearance defaults and storage", () => {
    test("starts from the light theme with the standard layout", () => {
        expect(defaultAppearance()).toEqual({
            activeTheme: "light",
            overrides: {},
            customThemes: [],
            layout: DEFAULT_LAYOUT,
        });
        expect(DEFAULT_LAYOUT).toEqual({
            density: "regular",
            radius: "classic",
            navHeight: "standard",
            contentWidth: "wide",
            lineHeight: "normal",
            textScale: "md",
            motion: "system",
        });
    });

    test("migrates the v1 theme keys once", () => {
        installStorage();
        memory.set(THEME_KEY, "aurora");
        memory.set(OVERRIDES_KEY, JSON.stringify({ aurora: { "--pf-lime": "#00ffcc" } }));
        const state = readAppearance();
        expect(state.activeTheme).toBe("aurora");
        expect(state.overrides).toEqual({ aurora: { "--pf-lime": "#00ffcc" } });
        expect(state.customThemes).toEqual([]);
        expect(state.layout).toEqual(DEFAULT_LAYOUT);
    });

    test("falls back to migration for corrupt appearance payloads", () => {
        installStorage();
        memory.set(THEME_KEY, "black");
        memory.set(APPEARANCE_KEY, "{broken");
        expect(readAppearance().activeTheme).toBe("black");
        memory.set(APPEARANCE_KEY, JSON.stringify({ activeTheme: 42, customThemes: "nope" }));
        expect(readAppearance().activeTheme).toBe("light");
    });

    test("round-trips the full state through storage", () => {
        installStorage();
        const saved = saveAppearance(editActiveToken(defaultAppearance(), "--pf-bg", "#101010"));
        expect(JSON.parse(memory.get(APPEARANCE_KEY)!).overrides.light["--pf-bg"]).toBe("#101010");
        expect(readAppearance()).toEqual(saved);
        memory.set(APPEARANCE_KEY, "junk");
        expect(readAppearance().overrides).toEqual({});
    });

    test("bootstraps the stored appearance without a document", () => {
        installStorage();
        const next = saveAppearance(selectTheme(defaultAppearance(), "cyber"));
        expect(applyStoredAppearance()).toEqual(next);
    });
});

describe("custom themes", () => {
    test("creates a named theme from the current builtin overrides", () => {
        const tweaked = editActiveToken(defaultAppearance(), "--pf-lime", "#123456");
        const { state, theme } = createCustomTheme(tweaked, "  夜航  ");
        expect(theme.name).toBe("夜航");
        expect(theme.base).toBe("light");
        expect(theme.tokens).toEqual({ "--pf-lime": "#123456" });
        expect(state.activeTheme).toBe(theme.id);
        expect(state.overrides).toEqual({});
        const resolved = resolveTheme(state);
        expect(resolved.custom).toBe(true);
        expect(resolved.base).toBe("light");
        expect(resolved.tokens["--pf-lime"]).toBe("#123456");
        expect(resolved.tokens["--pf-bg"]).toBe(THEMES.light.tokens["--pf-bg"]);
    });

    test("dedupes names and keeps the 24-theme ceiling", () => {
        let state = defaultAppearance();
        const first = createCustomTheme(state, "夜航");
        state = createCustomTheme(first.state, "夜航").state;
        expect(state.customThemes.map((item) => item.name)).toEqual(["夜航", "夜航 2"]);
        for (let index = 2; index < MAX_CUSTOM_THEMES; index += 1) {
            state = createCustomTheme(state, `主题 ${index}`).state;
        }
        expect(state.customThemes).toHaveLength(MAX_CUSTOM_THEMES);
        expect(() => createCustomTheme(state, "溢出")).toThrow("最多");
    });

    test("edits and resets tokens inside a custom theme, not in builtin overrides", () => {
        const { state } = createCustomTheme(defaultAppearance(), "夜航");
        const edited = editActiveToken(state, "--pf-bg", "rgba(10, 11, 12, 0.8)");
        expect(edited.customThemes[0].tokens["--pf-bg"]).toBe("rgba(10, 11, 12, 0.8)");
        expect(edited.overrides).toEqual({});
        expect(editActiveToken(edited, "--pf-bg", "not-a-colour")).toBe(edited);
        const reset = resetActiveTokens(edited);
        expect(reset.customThemes[0].tokens).toEqual({});
        expect(resolveTheme(reset).tokens["--pf-bg"]).toBe(THEMES.light.tokens["--pf-bg"]);
    });

    test("renames, deletes, and falls back to the base theme", () => {
        const { state, theme } = createCustomTheme(defaultAppearance(), "夜航");
        expect(renameCustomTheme(state, theme.id, "  深海  ").customThemes[0].name).toBe("深海");
        expect(renameCustomTheme(state, theme.id, "   ")).toBe(state);
        const deleted = deleteCustomTheme(state, theme.id);
        expect(deleted.customThemes).toEqual([]);
        expect(deleted.activeTheme).toBe("light");
        const other = createCustomTheme(defaultAppearance(), "海岸");
        const kept = deleteCustomTheme(other.state, "custom-missing");
        expect(kept.activeTheme).toBe(other.theme.id);
    });

    test("ignores unknown theme ids and keeps custom selections", () => {
        const { state } = createCustomTheme(defaultAppearance(), "夜航");
        expect(selectTheme(state, "neon").activeTheme).toBe("light");
        expect(selectTheme(state, state.activeTheme).activeTheme).toBe(state.activeTheme);
        expect(selectTheme(state, "cyber").activeTheme).toBe("cyber");
    });

    test("sanitizes imported theme lists and drops invalid entries", () => {
        const customs = Array.from({ length: MAX_CUSTOM_THEMES + 4 }, (_, index) => ({
            id: `custom-${index}`,
            name: `主题 ${index}`,
            base: index === 0 ? "neon" : "aurora",
            tokens: { "--pf-lime": index === 1 ? "rgb(300, 0, 0)" : "#00ffcc", "--pf-shadow": "0 0 0 red" },
        }));
        const clean = sanitizeAppearance({ activeTheme: "custom-2", customThemes: customs });
        expect(clean.customThemes).toHaveLength(MAX_CUSTOM_THEMES);
        expect(clean.customThemes[0].base).toBe("light");
        expect(clean.customThemes[0].tokens).toEqual({ "--pf-lime": "#00ffcc" });
        expect(clean.customThemes[1].tokens).toEqual({});
        expect(clean.activeTheme).toBe("custom-2");
        const duplicate = sanitizeAppearance({
            activeTheme: "custom-1",
            customThemes: [
                { id: "custom-1", name: "A", base: "light", tokens: {} },
                { id: "custom-1", name: "B", base: "light", tokens: {} },
            ],
        });
        expect(duplicate.customThemes).toHaveLength(1);
        expect(duplicate.activeTheme).toBe("custom-1");
    });
});

describe("colour helpers", () => {
    test("accepts hex and bounded rgb(a) values only", () => {
        expect(isCssColor("#abc")).toBe(true);
        expect(isCssColor("#aabbcc")).toBe(true);
        expect(isCssColor("rgb(0, 0, 0)")).toBe(true);
        expect(isCssColor("rgba(17, 19, 24, 0.1)")).toBe(true);
        expect(isCssColor("rgb(256, 0, 0)")).toBe(false);
        expect(isCssColor("rgba(0, 0, 0, 1.5)")).toBe(false);
        expect(isCssColor("0 8px 28px rgba(0,0,0,0.2)")).toBe(false);
        expect(isCssColor("url(https://example.com/x)")).toBe(false);
    });

    test("parses and formats colour inputs with alpha", () => {
        expect(parseColor("#abc")).toEqual({ hex: "#aabbcc", alpha: 1 });
        expect(parseColor("rgba(17, 19, 24, 0.1)")).toEqual({ hex: "#111318", alpha: 0.1 });
        expect(parseColor("rebeccapurple")).toBeNull();
        expect(formatColor("#111318", 0.1)).toBe("rgba(17, 19, 24, 0.1)");
        expect(formatColor("#111318", 1)).toBe("#111318");
    });
});

describe("layout preferences", () => {
    test("sanitizes unknown values back to defaults", () => {
        expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
        expect(sanitizeLayout({ density: "dense", radius: "round", motion: "off" })).toEqual({
            ...DEFAULT_LAYOUT,
            radius: "round",
        });
    });

    test("writes datasets, CSS variables and the root font size", () => {
        const { root, values } = fakeRoot();
        applyLayoutTo(root as unknown as HTMLElement, {
            density: "compact",
            radius: "round",
            navHeight: "relaxed",
            contentWidth: "full",
            lineHeight: "loose",
            textScale: "lg",
            motion: "reduced",
        });
        expect(root.dataset.density).toBe("compact");
        expect(root.dataset.contentWidth).toBe("full");
        expect(root.dataset.motion).toBe("reduced");
        expect(values.get("--pf-radius")).toBe("22px");
        expect(values.get("--pf-radius-sm")).toBe("16px");
        expect(values.get("--pf-nav-h")).toBe("56px");
        expect(values.get("--toiv-content-max")).toBe("1680px");
        expect(values.get("--toiv-space")).toBe("0.85");
        expect(values.get("--toiv-line-height")).toBe("1.7");
        expect(root.style.fontSize).toBe("17.6px");
        applyLayoutTo(root as unknown as HTMLElement, DEFAULT_LAYOUT);
        expect(values.get("--pf-radius")).toBe("14px");
        expect(root.style.fontSize).toBe("16px");
    });
});

describe("applying appearance", () => {
    test("writes builtin overrides and clears them when switching themes", () => {
        const { root, values } = fakeRoot();
        const state = editActiveToken(defaultAppearance(), "--pf-lime", "#00ffcc");
        applyAppearanceTo(root as unknown as HTMLElement, state);
        expect(root.dataset.theme).toBe("light");
        expect(root.dataset.themeKind).toBe("builtin");
        expect(values.get("--pf-lime")).toBe("#00ffcc");
        applyAppearanceTo(root as unknown as HTMLElement, selectTheme(state, "aurora"));
        expect(root.dataset.theme).toBe("aurora");
        expect(values.has("--pf-lime")).toBe(false);
    });

    test("applies a custom theme over its base palette", () => {
        const { root, values } = fakeRoot();
        const { state } = createCustomTheme(editActiveToken(defaultAppearance(), "--pf-lime", "#123456"), "夜航");
        applyAppearanceTo(root as unknown as HTMLElement, state);
        expect(root.dataset.theme).toBe("light");
        expect(root.dataset.themeKind).toBe("custom");
        expect(values.get("--pf-lime")).toBe("#123456");
        applyAppearanceTo(root as unknown as HTMLElement, selectTheme(state, "light"));
        expect(values.has("--pf-lime")).toBe(false);
        expect(root.dataset.themeKind).toBe("builtin");
    });
});

describe("import and export", () => {
    test("round-trips the current look and layout", () => {
        let state = editActiveToken(defaultAppearance(), "--pf-line", "rgba(10, 20, 30, 0.25)");
        state = createCustomTheme(state, "夜航").state;
        state = { ...state, layout: { ...DEFAULT_LAYOUT, density: "relaxed", contentWidth: "focus" } };
        const text = exportAppearance(state);
        const payload = JSON.parse(text);
        expect(payload.schema).toBe("toiv.appearance");
        expect(payload.version).toBe(2);
        expect(payload.theme.name).toBe("夜航");
        expect(payload.theme.base).toBe("light");
        expect(payload.theme.tokens["--pf-line"]).toBe("rgba(10, 20, 30, 0.25)");
        expect(payload.layout.density).toBe("relaxed");

        const target = defaultAppearance();
        const imported = importAppearance(text, target);
        expect(imported.state.activeTheme).not.toBe(state.activeTheme);
        expect(imported.theme.name).toBe("夜航");
        expect(resolveTheme(imported.state).tokens["--pf-line"]).toBe("rgba(10, 20, 30, 0.25)");
        expect(imported.state.layout.density).toBe("relaxed");
        expect(imported.state.layout.contentWidth).toBe("focus");
        expect(imported.state.overrides).toEqual({});
    });

    test("suffixes colliding names and ignores missing layouts", () => {
        const first = createCustomTheme(defaultAppearance(), "夜航");
        const text = exportAppearance(first.state);
        const imported = importAppearance(text, first.state);
        expect(imported.theme.name).toBe("夜航 2");
        const payload = JSON.parse(text);
        delete payload.layout;
        const second = importAppearance(JSON.stringify(payload), defaultAppearance());
        expect(second.state.layout).toEqual(DEFAULT_LAYOUT);
    });

    test("rejects malformed or oversized payloads", () => {
        const state = defaultAppearance();
        expect(() => importAppearance("not json", state)).toThrow("JSON");
        expect(() => importAppearance(JSON.stringify({ schema: "other", version: 2 }), state)).toThrow("schema");
        expect(() => importAppearance(JSON.stringify({ schema: "toiv.appearance", version: 3 }), state)).toThrow("version");
        expect(() => importAppearance(JSON.stringify({
            schema: "toiv.appearance", version: 2, theme: { base: "light", tokens: {} },
        }), state)).toThrow("名称");
        expect(() => importAppearance("x".repeat(64 * 1024 + 1), state)).toThrow("64");
        expect(() => importAppearance(JSON.stringify({
            schema: "toiv.appearance", version: 2, theme: { name: "夜航", base: "light", tokens: { "--pf-bg": "red" } },
        }), state)).not.toThrow();
    });
});
