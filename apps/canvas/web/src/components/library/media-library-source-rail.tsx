import { FolderOpen, History, Library } from "lucide-react";
import { useNavigate } from "react-router";

import {
    mediaLibraryHref,
    type MediaLibrarySource,
} from "@/lib/media-library-routes";
import { cn } from "@/lib/utils";

type MediaLibrarySourceRailProps = {
    active: MediaLibrarySource;
    worksCount?: number;
    materialsCount?: number;
    historyCount?: number;
};

const RAIL_ITEMS: Array<{
    source: MediaLibrarySource;
    label: string;
    Icon: typeof Library;
    countKey: "worksCount" | "materialsCount" | "historyCount";
}> = [
    { source: "works", label: "作品", Icon: Library, countKey: "worksCount" },
    { source: "materials", label: "素材", Icon: FolderOpen, countKey: "materialsCount" },
    { source: "history", label: "生成历史", Icon: History, countKey: "historyCount" },
];

/** Three-source rail for the unified 媒体库 shell (works / materials / history). */
export function MediaLibrarySourceRail({
    active,
    worksCount,
    materialsCount,
    historyCount,
}: MediaLibrarySourceRailProps) {
    const navigate = useNavigate();
    const counts = { worksCount, materialsCount, historyCount };

    return (
        <aside className="assets-library-source-rail" aria-label="媒体库来源导航">
            <div className="assets-library-source-rail-inner">
                {RAIL_ITEMS.map(({ source, label, Icon, countKey }) => {
                    const isActive = active === source;
                    const count = counts[countKey];
                    return (
                        <button
                            key={source}
                            type="button"
                            className={cn("assets-library-source-rail-item", isActive && "is-active")}
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => {
                                if (!isActive) navigate(mediaLibraryHref(source));
                            }}
                        >
                            <span className="assets-library-source-rail-icon">
                                <Icon className="size-3.5" />
                            </span>
                            <span>{label}</span>
                            {typeof count === "number" ? (
                                <span className="assets-filter-count">{count}</span>
                            ) : null}
                        </button>
                    );
                })}
            </div>
        </aside>
    );
}
