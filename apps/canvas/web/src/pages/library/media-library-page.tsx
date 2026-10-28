import { PersonStanding } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { MediaLibrarySourceRail } from "@/components/library/media-library-source-rail";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { ToivEmptyState } from "@/components/toiv/toiv-empty-state";
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
 * `poses` is reserved empty for W5 (thumbs/img under /api/pose-gallery/*, never /static).
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
            {source === "poses" ? <PosesComingSoonTrack /> : null}
            <MediaLibrarySourceRail
                active={railActive}
                worksCount={worksCount}
                materialsCount={materialsCount}
                historyCount={historyCount}
            />
        </WorkspacePage>
    );
}

function PosesComingSoonTrack() {
    return (
        <div className="studio-band assets-library-hero mx-auto flex w-full max-w-6xl flex-col gap-3 px-3 py-6 sm:px-4">
            <header className="app-page-header">
                <h1 className="app-page-header-title font-semibold">姿势</h1>
                <p className="mt-1 text-xs text-foreground/58">姿势参考库 · 即将接入</p>
            </header>
            <ToivEmptyState
                className="fz-panel"
                icon={PersonStanding}
                title="姿势库即将接入"
                description="本轨已预留。图库将走 /api/pose-gallery/thumbs 与 /api/pose-gallery/img（不用 /static）。"
            />
        </div>
    );
}
