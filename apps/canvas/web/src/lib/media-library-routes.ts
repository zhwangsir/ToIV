/** Unified media-library shell routes (P0: shell only; boards ≠ Go assets). */

export type MediaLibrarySource = "works" | "materials" | "history";

export const MEDIA_LIBRARY_PATH = "/library";

export function mediaLibraryHref(source: MediaLibrarySource = "works"): string {
    if (source === "materials") return `${MEDIA_LIBRARY_PATH}?source=materials`;
    if (source === "history") return `${MEDIA_LIBRARY_PATH}?source=history`;
    return `${MEDIA_LIBRARY_PATH}?source=works`;
}

export function mediaLibraryWorksDetailPath(boardId: string): string {
    return `${MEDIA_LIBRARY_PATH}/works/${encodeURIComponent(boardId)}`;
}

/** Accept `source=` (new) or legacy `tab=history|personal`. Default works. */
export function parseMediaLibrarySource(value: string | null | undefined): MediaLibrarySource {
    if (value === "materials" || value === "personal") return "materials";
    if (value === "history") return "history";
    if (value === "works") return "works";
    return "works";
}
