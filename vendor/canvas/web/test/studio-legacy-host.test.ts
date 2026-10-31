import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relative: string) => readFileSync(resolve(import.meta.dir, "..", relative), "utf8");

const router = read("src/router.tsx");
const css = read("src/studio/studio.css");
const legacyHost = read("src/studio/routes/studio-legacy-host-route.tsx");
const createRoute = read("src/studio/routes/studio-create-route.tsx");
const editRoute = read("src/studio/routes/studio-edit-route.tsx");
const canvasRoute = read("src/studio/routes/studio-canvas-route.tsx");

describe("legacy host strangler", () => {
    test("shared pages are top-level studio routes", () => {
        for (const path of ["/library", "/tasks", "/settings", "/toiv/drama", "/toiv/market", "/agents", "/toiv/kpi", "/plugins", "/plugins/eagle"]) {
            expect(router).toContain(`{ path: "${path}", element: deferred(<Studio`);
        }
        expect(router).toContain('{ path: "/home", element: <Navigate to="/create" replace /> }');
    });
    test("plugin pages stay behind their feature gate", () => {
        expect(legacyHost).toContain('<RequireFeature feature="pluginCenterEnabled">');
    });
    test("demote rule hides duplicated title cluster but keeps actions", () => {
        expect(css).toContain(".stv-legacy-host .app-page-header-main { display: none; }");
        expect(css).not.toContain(".stv-legacy-host .app-page-header {");
    });
    test("bare main column under the shell keeps horizontal padding", () => {
        expect(css).toContain(".stv-shell > .stv-main { padding: 0 20px 18px; }");
    });
});

describe("face fallback removal", () => {
    test("no face route reads a fallback flag", () => {
        for (const source of [createRoute, editRoute, canvasRoute]) {
            expect(source).not.toContain("studioFaceEnabled");
            expect(source).not.toContain("VITE_STUDIO_FACE_FALLBACK");
        }
        expect(read("src/studio/flags.ts")).not.toContain("studioFaceEnabled");
    });
    test("/create without project bridges to the legacy composer instead of dead-ending", () => {
        expect(createRoute).toContain("if (!projectId) return <StudioCreateHomeRoute />;");
        expect(legacyHost).toContain("export function StudioCreateHomeRoute()");
        expect(legacyHost).toContain('import("@/pages/create/creation-workbench")');
    });
    test("load failure surfaces a toast rather than silently falling back", () => {
        expect(canvasRoute).toContain("项目列表加载失败");
        expect(createRoute).toContain("项目载入失败");
        expect(editRoute).toContain("剪辑湾载入失败");
    });
});
