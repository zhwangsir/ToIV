import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skin = readFileSync(`${root}app/styles/web-studio-skin.css`, "utf8");
const layout = readFileSync(`${root}app/layout.tsx`, "utf8");
const landing = readFileSync(`${root}components/landing/LandingPage.tsx`, "utf8");

test("web studio skin maps tokens inside landing scope only", () => {
    assert.match(skin, /\.landing \{/);
    assert.match(skin, /--bg-canvas: var\(--background\)/);
    assert.match(skin, /--accent: var\(--primary\)/);
    assert.equal(/#[0-9a-fA-F]{6}/.test(skin), false);
});

test("layout imports studio tokens and skin", () => {
    assert.match(layout, /styles\/studio-tokens\.css/);
    assert.match(layout, /styles\/web-studio-skin\.css/);
});

test("landing root carries studio dark scope", () => {
    assert.match(landing, /className="landing dark"/);
});
