import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webTokens = readFileSync(join(webRoot, "app/styles/toiv-freezone-tokens.css"), "utf8");
const canvasTokens = readFileSync(join(webRoot, "../canvas/web/src/styles/toiv-freezone-tokens.css"), "utf8");

function tokens(source: string): Record<string, string> {
    const root = source.match(/:root\s*\{([\s\S]*?)\n\}/);
    assert.ok(root);
    return Object.fromEntries([...root[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function luminance(hex: string): number {
    const match = hex.match(/^#([0-9a-f]{6})$/i);
    assert.ok(match, `invalid hex color: ${hex}`);
    const channels = match[1].match(/.{2}/g);
    assert.ok(channels);
    const [r, g, b] = channels.map((value) => parseInt(value, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("Freezone tokens stay identical across web and canvas", () => {
    assert.equal(webTokens, canvasTokens);
});

test("Freezone muted text and primary action meet WCAG AA", () => {
    const palette = tokens(webTokens);
    for (const surface of ["--toiv-bg", "--toiv-surface", "--toiv-surface-raised", "--toiv-surface-panel"]) {
        assert.ok(contrast(palette["--toiv-text-muted"], palette[surface]) >= 4.5, `${surface} muted contrast`);
    }
    assert.ok(contrast(palette["--toiv-text-on-accent"], palette["--toiv-accent"]) >= 4.5);
});

test("Freezone shell geometry remains compact and token driven", () => {
    const palette = tokens(webTokens);
    assert.equal(palette["--toiv-shell-sidebar"], "250px");
    assert.equal(palette["--toiv-shell-sidebar-collapsed"], "67px");
    assert.equal(palette["--toiv-shell-topbar"], "56px");
    assert.equal(palette["--toiv-shell-control"], "32px");
    assert.equal(palette["--toiv-shell-nav-row"], "36px");
});

test("Light-curtain text, focus and adult thumb meet contrast budgets", () => {
    const palette = tokens(webTokens);
    const resolve = (value: string): string => {
        const reference = value.match(/^var\((--[\w-]+)\)$/);
        return reference ? resolve(palette[reference[1]]) : value;
    };
    const rgb = (hex: string) => hex.match(/[0-9a-f]{2}/gi)!.map((value) => parseInt(value, 16));
    const hex = (channels: number[]) => `#${channels.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
    const background = palette["--toiv-switch-bg"];
    const alpha = Number(palette["--toiv-switch-thumb-nsfw"].match(/\/\s*([\d.]+)\)/)?.[1]);
    assert.ok(alpha > 0 && alpha < 1);
    const base = rgb(background);
    const adultThumb = hex(base.map((channel, index) => channel * (1 - alpha) + [79, 140, 255][index] * alpha));
    assert.equal(palette["--toiv-switch-h"], "28px");
    assert.ok(contrast(resolve(palette["--toiv-switch-fg"]), background) >= 4.5);
    assert.ok(contrast(palette["--toiv-switch-fg-active-nsfw"], adultThumb) >= 4.5);
    assert.ok(contrast(palette["--toiv-switch-focus"], background) >= 3);
});
