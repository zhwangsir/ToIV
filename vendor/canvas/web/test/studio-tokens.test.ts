import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const canvasTokens = readFileSync(resolve(import.meta.dir, "../src/studio/theme/tokens.css"), "utf8");
const webTokens = readFileSync(resolve(import.meta.dir, "../../../web/app/styles/studio-tokens.css"), "utf8");

const REQUIRED = ["--background", "--foreground", "--surface-1", "--surface-2", "--surface-3", "--muted-fg", "--faint-fg",
    "--border", "--border-strong", "--primary", "--primary-fg", "--primary-soft", "--success", "--warning", "--destructive",
    "--overlay", "--shadow-1", "--shadow-2", "--shadow-3", "--radius-xl", "--radius-lg", "--radius-md", "--radius-sm",
    "--radius-pill", "--dur-1", "--dur-2", "--dur-3", "--ease-tab", "--font-ui", "--font-mono"];

describe("studio tokens", () => {
    test("defines the semantic contract", () => {
        for (const name of REQUIRED) expect(canvasTokens).toContain(name + ":");
    });
    test("dark is default and light overrides same structure", () => {
        expect(canvasTokens).toContain(".dark {");
        const lightBlock = canvasTokens.slice(0, canvasTokens.indexOf(".dark {"));
        const darkBlock = canvasTokens.slice(canvasTokens.indexOf(".dark {"));
        for (const name of ["--background", "--primary", "--surface-1"]) {
            expect(lightBlock).toContain(name + ":");
            expect(darkBlock).toContain(name + ":");
        }
    });
    test("web copy body is byte-identical", () => {
        const body = (s: string) => s.slice(s.indexOf("/* tokens-body */"));
        expect(body(webTokens)).toBe(body(canvasTokens));
    });
    test("reduced motion zeroes durations", () => {
        expect(canvasTokens).toContain("prefers-reduced-motion");
    });
});
