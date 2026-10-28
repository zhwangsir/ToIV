import { FolderOpen, History, Library, PersonStanding } from "lucide-react";
import { useNavigate } from "react-router";

import {
    mediaLibraryHref,
    type MediaLibrarySource,
} from "@/lib/media-library-routes";
import { cn } from "@/lib/utils";

type MediaLibrarySourceRailProps = {
    /** 当前来源页签；不传 = 当前视图不是来源项之一（如画板/台词检索子页），不高亮任何项。 */
    active?: MediaLibrarySource;
    worksCount?: number;
    materialsCount?: number;
    historyCount?: number;
    posesCount?: number;
};

const RAIL_ITEMS: Array<{
    source: MediaLibrarySource;
    label: string;
    Icon: typeof Library;
    countKey: "worksCount" | "materialsCount" | "historyCount" | "posesCount";
}> = [
    { source: "works", label: "作品", Icon: Library, countKey: "worksCount" },
    { source: "materials", label: "素材", Icon: FolderOpen, countKey: "materialsCount" },
    { source: "history", label: "生成历史", Icon: History, countKey: "historyCount" },
    { source: "poses", label: "姿势", Icon: PersonStanding, countKey: "posesCount" },
];

/** Source rail for the unified 媒体库 shell (works / materials / history / poses). */
export function MediaLibrarySourceRail({
    active,
    worksCount,
    materialsCount,
    historyCount,
    posesCount,
}: MediaLibrarySourceRailProps) {
    const navigate = useNavigate();
    const counts = { worksCount, materialsCount, historyCount, posesCount };

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
