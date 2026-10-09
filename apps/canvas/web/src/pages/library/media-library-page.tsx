import { useSearchParams } from "react-router";

import { parseMediaLibrarySource } from "@/lib/media-library-routes";
import AssetsPage from "@/pages/assets";
import LibraryPage from "@/pages/toiv/library-page";

/**
 * Unified 媒体库 shell: one nav entry, three source rails.
 * Reuses existing page modules — does not merge boards ↔ Go assets backends.
 */
export default function MediaLibraryPage() {
    const [searchParams] = useSearchParams();
    const source = parseMediaLibrarySource(
        searchParams.get("source") ?? searchParams.get("tab"),
    );
    if (source === "works") return <LibraryPage />;
    return <AssetsPage />;
}
