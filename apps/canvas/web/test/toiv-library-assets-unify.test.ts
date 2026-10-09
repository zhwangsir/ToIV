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
    test("mediaLibraryHref covers three sources", () => {
        expect(MEDIA_LIBRARY_PATH).toBe("/library");
        expect(mediaLibraryHref("works")).toBe("/library?source=works");
        expect(mediaLibraryHref("materials")).toBe("/library?source=materials");
        expect(mediaLibraryHref("history")).toBe("/library?source=history");
        expect(mediaLibraryWorksDetailPath("board-1")).toBe("/library/works/board-1");
    });

    test("parseMediaLibrarySource accepts source= and legacy tab=", () => {
        expect(parseMediaLibrarySource("works")).toBe("works");
        expect(parseMediaLibrarySource("materials")).toBe("materials");
        expect(parseMediaLibrarySource("history")).toBe("history");
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
    test("sidebar single 媒体库 entry; dual 资产/作品库 gone", () => {
        const nav = read("src/components/layout/workspace-sidebar-nav.tsx");
        expect(nav).toContain('title: "媒体库"');
        expect(nav).toContain('to: "/library"');
        expect(nav).toContain('id: "library"');
        expect(nav).not.toContain('title: "资产"');
        expect(nav).not.toContain('title: "作品库"');
        expect(nav).not.toContain('to: "/assets"');
        expect(nav).not.toContain('to: "/toiv/library"');
    });

    test("capacity / palette / eagle / home / agent point into shell", () => {
        const meter = read("src/components/layout/workspace-sidebar-storage-meter.tsx");
        expect(meter).toContain('to="/library?source=materials"');

        const palette = read("src/components/layout/workspace-command-palette.tsx");
        expect(palette).toContain('title: "媒体库"');
        expect(palette).toContain('"/library?source=materials"');
        expect(palette).toContain('id: "library"');

        const eagle = read("src/pages/plugins/eagle.tsx");
        expect(eagle).toContain('navigate("/library?source=materials")');
        expect(eagle).not.toContain('navigate("/assets")');

        const home = read("src/pages/home/home-data.ts");
        expect(home).toContain('to: "/library?source=works"');

        const agent = read("src/pages/toiv/agent-page.tsx");
        expect(agent).toContain("`/library/works/${encodeURIComponent(boardId)}`");

        const float = read("src/pages/canvas/toiv-agent-float.tsx");
        expect(float).toContain("`/library/works/${encodeURIComponent(boardId)}`");
    });

    test("shell reuses page modules; three-source rail present", () => {
        const shell = read("src/pages/library/media-library-page.tsx");
        expect(shell).toContain('from "@/pages/toiv/library-page"');
        expect(shell).toContain('from "@/pages/assets"');
        expect(shell).toContain("parseMediaLibrarySource");

        const rail = read("src/components/library/media-library-source-rail.tsx");
        expect(rail).toContain('"作品"');
        expect(rail).toContain('"素材"');
        expect(rail).toContain('"生成历史"');
        expect(rail).toContain("媒体库来源导航");

        const library = read("src/pages/toiv/library-page.tsx");
        expect(library).toContain("MediaLibrarySourceRail");
        expect(library).toContain('active="works"');
        expect(library).toContain("mediaLibraryWorksDetailPath");

        const assets = read("src/pages/assets/index.tsx");
        expect(assets).toContain("MediaLibrarySourceRail");
        expect(assets).toContain('active="materials"');
        expect(assets).toContain('active="history"');
        expect(assets).not.toContain("/assets?tab=");
    });
});
