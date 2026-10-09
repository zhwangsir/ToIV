import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const overrides = readFileSync(join(root, "src/styles/toiv-local-overrides.css"), "utf8");
const app = readFileSync(join(root, "src/application.tsx"), "utf8");
const webDetails = readFileSync(
    join(root, "../../web/app/styles/details.css"),
    "utf8",
);

describe("feat/studio-scrollbar-beeftv contracts", () => {
    test("canvas imports toiv-local-overrides after globals", () => {
        expect(app).toContain('import "./styles/globals.css"');
        expect(app).toContain('import "./styles/toiv-local-overrides.css"');
        const g = app.indexOf('import "./styles/globals.css"');
        const o = app.indexOf('import "./styles/toiv-local-overrides.css"');
        expect(o).toBeGreaterThan(g);
    });

    test("overrides define BeefTV scroll tokens and html thin bar", () => {
        expect(overrides).toContain("--toiv-scroll-thumb");
        expect(overrides).toContain("--toiv-scroll-thumb-hover");
        expect(overrides).toContain("--toiv-scroll-size: 6px");
        expect(overrides).toContain("scrollbar-width: thin");
        expect(overrides).toContain("scrollbar-color: var(--toiv-scroll-thumb)");
        expect(overrides).toContain("::-webkit-scrollbar");
        // hover uses workspace/user accent — not RH lime hex
        expect(overrides).toContain("var(--user-accent, var(--workspace-accent");
        expect(overrides).not.toMatch(/#C9F24F|#84cc16|#a3e635/i);
    });

    test("utility class retokens cover market/sidebar/drawer hosts", () => {
        for (const cls of [
            ".thin-scrollbar",
            ".creation-scrollbar",
            ".hover-scrollbar",
            ".storyboard-scrollbar",
            ".app-workspace-sidebar-scroll-area",
            ".ant-drawer-body",
            ".ant-modal-body",
        ]) {
            expect(overrides).toContain(cls);
        }
        // intentional hides must remain untouched here
        expect(overrides).not.toContain(".hide-scrollbar {");
        expect(overrides).not.toContain(".app-workspace-scroll {");
    });

    test("web details.css thin 6px and hover avoids cinema lime accent", () => {
        expect(webDetails).toContain("::-webkit-scrollbar { width: 6px; height: 6px; }");
        expect(webDetails).toContain("--ui-scroll-thumb-hover");
        expect(webDetails).toContain("var(--border-strong");
        // must not drive scrollbar hover with lime --accent
        const hoverLine = webDetails
            .split("\n")
            .find((l) => l.includes("--ui-scroll-thumb-hover:"));
        expect(hoverLine).toBeTruthy();
        expect(hoverLine!).not.toContain("var(--accent)");
        expect(webDetails).not.toMatch(/--ui-scroll-thumb-hover:[^;]*#C9F24F/i);
    });
});
