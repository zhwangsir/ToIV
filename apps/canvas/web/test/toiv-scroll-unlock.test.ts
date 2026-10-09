import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const workspacePage = readFileSync(
    join(root, "src/components/layout/workspace-page.tsx"),
    "utf8",
);
const overrides = readFileSync(join(root, "src/styles/toiv-local-overrides.css"), "utf8");
const homeCss = readFileSync(join(root, "src/pages/home/home-dashboard.css"), "utf8");

const toivPages = [
    "market-page.tsx",
    "library-page.tsx",
    "library-detail.tsx",
    "drama-page.tsx",
    "drama-detail.tsx",
    "tasks-page.tsx",
] as const;

describe("feat/studio-scroll-unlock contracts", () => {
    test("WorkspacePage default scroll class is overflow-y-auto app-workspace-scroll", () => {
        expect(workspacePage).toContain('scroll && "app-workspace-scroll overflow-y-auto"');
    });

    test("six ToIV pages wrap WorkspacePage (fluid) for shell unlock", () => {
        for (const name of toivPages) {
            const src = readFileSync(join(root, "src/pages/toiv", name), "utf8");
            expect(src).toContain('from "@/components/layout/workspace-page"');
            expect(src).toContain("<WorkspacePage fluid");
            expect(src).toContain("</WorkspacePage>");
            // no bare mx-auto root main (must scroll via WorkspacePage)
            expect(src).not.toMatch(/<main className="mx-auto flex w-full max-w-/);
        }
    });

    test("product workspace restores thin .app-workspace-scroll (not blind hide)", () => {
        expect(overrides).toContain(".app-product-workspace .app-workspace-scroll");
        expect(overrides).toContain("scrollbar-width: thin !important");
        expect(overrides).toContain("var(--toiv-scroll-thumb)");
        // webkit display restored (override spatial display:none)
        expect(overrides).toContain(
            ".app-product-workspace .app-workspace-scroll::-webkit-scrollbar",
        );
        expect(overrides).toContain("display: block !important");
    });

    test(".toiv-home uses --toiv-scroll-* tokens", () => {
        expect(homeCss).toContain("scrollbar-width: thin");
        expect(homeCss).toContain("var(--toiv-scroll-thumb");
        expect(homeCss).toContain("var(--toiv-scroll-thumb-hover");
        expect(homeCss).toContain("var(--toiv-scroll-track");
        // old hard-only border-strong path should not be the sole scrollbar-color
        const homeBlock = homeCss.slice(homeCss.indexOf(".toiv-home {"), homeCss.indexOf(".toiv-home-hero"));
        expect(homeBlock).not.toMatch(/scrollbar-color:\s*var\(--user-border-strong\)\s+transparent/);
    });
});
