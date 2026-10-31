import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { MediaLibrarySourceRail } from "@/components/library/media-library-source-rail";
import { PoseBrowser } from "@/components/pose/pose-browser";
import { WorkspacePage } from "@/components/layout/workspace-page";
import {
    parseMediaLibrarySource,
    type MediaLibrarySource,
} from "@/lib/media-library-routes";
import { cn } from "@/lib/utils";
import AssetsPage from "@/pages/assets";
import LibraryPage from "@/pages/toiv/library-page";
import "@/styles/toiv-freezone-desk.css";

/**
 * W4 · Unified 媒体库 shell: one WorkspacePage + one source rail + track panels.
 * Track panels (works / materials / history) no longer own their own page chrome.
 * W5 · `poses` track: PoseBrowser grid (thumbs/img under /api/pose-gallery/*, never /static).
 */
export default function MediaLibraryPage() {
    const [searchParams] = useSearchParams();
    const source = parseMediaLibrarySource(
        searchParams.get("source") ?? searchParams.get("tab"),
    );
    const [railActive, setRailActive] = useState<MediaLibrarySource | undefined>(source);
    const [worksCount, setWorksCount] = useState<number | undefined>(undefined);
    const [materialsCount, setMaterialsCount] = useState<number | undefined>(undefined);
    const [historyCount, setHistoryCount] = useState<number | undefined>(undefined);

    useEffect(() => {
        setRailActive(source === "works" ? "works" : source);
    }, [source]);

    const onWorksRailActive = useCallback((next: MediaLibrarySource | undefined) => {
        setRailActive(next);
    }, []);

    const onMaterialsCounts = useCallback((next: { materials?: number; history?: number }) => {
        if (typeof next.materials === "number") setMaterialsCount(next.materials);
        if (typeof next.history === "number") setHistoryCount(next.history);
    }, []);

    const shellClass = cn(
        "library-page assets-library-page",
        source === "works" && "toiv-library-page fz-desk",
        (source === "materials" || source === "history" || source === "poses") && "canvas-library-page",
        source === "history" && "generation-history-page",
        source === "poses" && "media-library-poses-track",
    );

    return (
        <WorkspacePage
            fluid={source === "works"}
            grid={source !== "works"}
            className={shellClass}
        >
            {source === "works" ? (
                <LibraryPage
                    embedded
                    onRailActiveChange={onWorksRailActive}
                    onWorksCountChange={setWorksCount}
                />
            ) : null}
            {source === "materials" || source === "history" ? (
                <AssetsPage
                    embedded
                    forcedSource={source}
                    onCountsChange={onMaterialsCounts}
                />
            ) : null}
            {source === "poses" ? <PosesTrack /> : null}
            <MediaLibrarySourceRail
                active={railActive}
                worksCount={worksCount}
                materialsCount={materialsCount}
                historyCount={historyCount}
            />
        </WorkspacePage>
    );
}

function PosesTrack() {
    return (
        <div
            className="studio-band assets-library-hero mx-auto flex w-full max-w-6xl flex-col gap-3 px-3 py-6 sm:px-4"
            data-testid="media-library-poses-track"
        >
            <header className="app-page-header">
                <h1 className="app-page-header-title font-semibold">姿势</h1>
                <p className="mt-1 text-xs text-foreground/58">姿势参考库 · /api/pose-gallery（不用 /static）</p>
            </header>
            <PoseBrowser className="fz-panel" title="姿势库" meta="媒体库姿势轨 · 只读浏览" />
        </div>
    );
}
