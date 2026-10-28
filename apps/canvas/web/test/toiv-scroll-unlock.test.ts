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
    "tasks-page.tsx",
] as const;

describe("feat/studio-scroll-unlock contracts", () => {
    test("WorkspacePage default scroll class is overflow-y-auto app-workspace-scroll", () => {
        expect(workspacePage).toContain('scroll && "app-workspace-scroll overflow-y-auto"');
    });

    test("ToIV list/detail pages wrap WorkspacePage (fluid) for shell unlock", () => {
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

    test(".toiv-home 走 --toiv-scroll-* 共享 token（R12 起由 html 级继承）", () => {
        // Freezone 首页重构后着色不再内联在 home css：toiv-local-overrides 的
        // html { scrollbar-color: var(--toiv-scroll-thumb) var(--toiv-scroll-track) } 继承生效，
        // .toiv-home 只保留细轨并禁止硬编码旧路径回退。
        expect(homeCss).toContain("scrollbar-width: thin");
        expect(homeCss).not.toContain("scrollbar-color:");
        expect(overrides).toContain("scrollbar-color: var(--toiv-scroll-thumb) var(--toiv-scroll-track)");
        expect(homeCss).not.toMatch(/scrollbar-color:\s*var\(--user-border-strong\)\s+transparent/);
    });
});
