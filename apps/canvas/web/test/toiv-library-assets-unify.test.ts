import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    MEDIA_LIBRARY_PATH,
    mediaLibraryHref,
    mediaLibraryWorksDetailPath,
    parseMediaLibrarySource,
} from "../src/lib/media-library-routes";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("feat/studio-library-assets-unify — route helpers", () => {
    test("mediaLibraryHref covers four sources (W4 + poses reserve)", () => {
        expect(MEDIA_LIBRARY_PATH).toBe("/library");
        expect(mediaLibraryHref("works")).toBe("/library?source=works");
        expect(mediaLibraryHref("materials")).toBe("/library?source=materials");
        expect(mediaLibraryHref("history")).toBe("/library?source=history");
        expect(mediaLibraryHref("poses")).toBe("/library?source=poses");
        expect(mediaLibraryWorksDetailPath("board-1")).toBe("/library/works/board-1");
    });

    test("parseMediaLibrarySource accepts source= and legacy tab=", () => {
        expect(parseMediaLibrarySource("works")).toBe("works");
        expect(parseMediaLibrarySource("materials")).toBe("materials");
        expect(parseMediaLibrarySource("history")).toBe("history");
        expect(parseMediaLibrarySource("poses")).toBe("poses");
        expect(parseMediaLibrarySource("personal")).toBe("materials");
        expect(parseMediaLibrarySource(null)).toBe("works");
        expect(parseMediaLibrarySource(undefined)).toBe("works");
    });
});

describe("feat/studio-library-assets-unify — router redirect matrix", () => {
    const router = read("src/router.tsx");

    test("primary /library + /library/works/:id registered", () => {
        expect(router).toContain('path: "/library"');
        expect(router).toContain('path: "/library/works/:id"');
        expect(router).toContain("media-library-page");
    });

    test("legacy /assets and /toiv/library* redirect into shell", () => {
        expect(router).toContain("AssetsLegacyRedirect");
        expect(router).toContain('to="/library?source=history"');
        expect(router).toContain('to="/library?source=materials"');
        expect(router).toContain('path: "/toiv/library"');
        expect(router).toContain('to="/library?source=works"');
        expect(router).toContain("ToivLibraryDetailRedirect");
        expect(router).toContain('path: "/toiv/library/:id"');
        // Must not still mount AssetsPage / ToivLibraryPage as primary elements
        expect(router).not.toContain("deferred(<AssetsPage");
        expect(router).not.toContain("deferred(<ToivLibraryPage");
    });
});

describe("feat/studio-library-assets-unify — nav + entry points", () => {
    test("W1：侧栏高级不再主推媒体库；资产/作品库双入口仍不得回潮", () => {
        const nav = read("src/components/layout/workspace-sidebar-nav.tsx");
        expect(nav).not.toContain('title: "媒体库"');
        expect(nav).not.toContain('id: "library"');
        expect(nav).not.toContain('title: "资产"');
        expect(nav).not.toContain('title: "作品库"');
        expect(nav).not.toContain('to: "/assets"');
        expect(nav).not.toContain('to: "/toiv/library"');
        // /library 路由仍在 router；只是不进一级/高级主推
        const router = read("src/router.tsx");
        expect(router).toContain('path: "/library"');
    });

    test("capacity / eagle / home / float point into library shell", () => {
        const meter = read("src/components/layout/workspace-sidebar-storage-meter.tsx");
        expect(meter).toContain('to="/library?source=materials"');

        // W1：⌘K 白名单不再暴露媒体库站点地图
        const palette = read("src/components/layout/workspace-command-palette.tsx");
        expect(palette).not.toContain('id: "library"');
        expect(palette).not.toContain('title: "媒体库"');

        const eagle = read("src/pages/plugins/eagle.tsx");
        expect(eagle).toContain('navigate("/library?source=materials")');
        expect(eagle).not.toContain('navigate("/assets")');

        const home = read("src/pages/home/home-data.ts");
        expect(home).toContain('to: "/library?source=works"');

        const float = read("src/pages/canvas/toiv-agent-float.tsx");
        expect(float).toContain("`/library/works/${encodeURIComponent(boardId)}`");
    });

    test("W4 shell owns chrome; track panels embed; poses rail reserved", () => {
        const shell = read("src/pages/library/media-library-page.tsx");
        expect(shell).toContain('from "@/pages/toiv/library-page"');
        expect(shell).toContain('from "@/pages/assets"');
        expect(shell).toContain("parseMediaLibrarySource");
        expect(shell).toContain("MediaLibrarySourceRail");
        expect(shell).toContain("WorkspacePage");
        expect(shell).toContain('embedded');
        expect(shell).toContain("PosesComingSoonTrack");
        expect(shell).toContain("姿势库即将接入");

        const rail = read("src/components/library/media-library-source-rail.tsx");
        expect(rail).toContain('"作品"');
        expect(rail).toContain('"素材"');
        expect(rail).toContain('"生成历史"');
        expect(rail).toContain('"姿势"');
        expect(rail).toContain("媒体库来源导航");
        // Wave A(2026-10-16):active 改可选——画板/台词检索子页不高亮来源项
        expect(rail).toContain("active?: MediaLibrarySource");

        const routes = read("src/lib/media-library-routes.ts");
        expect(routes).toContain('POSE_GALLERY_THUMB_PATH = "/api/pose-gallery/thumbs"');
        expect(routes).toContain('POSE_GALLERY_IMG_PATH = "/api/pose-gallery/img"');
        expect(routes).not.toContain("/static/pose");

        const library = read("src/pages/toiv/library-page.tsx");
        expect(library).toContain("embedded");
        expect(library).toContain("onRailActiveChange");
        expect(library).toContain("mediaLibraryWorksDetailPath");
        expect(library).toContain("ToivEmptyState");

        const assets = read("src/pages/assets/index.tsx");
        expect(assets).toContain("embedded");
        expect(assets).toContain("forcedSource");
        expect(assets).toContain("MediaLibraryTrackShell");
        expect(assets).toContain('active="materials"');
        expect(assets).toContain('active="history"');
        expect(assets).not.toContain("/assets?tab=");

        const works = read("src/pages/toiv/library-works.tsx");
        expect(works).toContain("ToivEmptyState");
        expect(works).not.toContain('from "@/components/ui/product/empty-state"');
    });
});
