/** Unified media-library shell routes (W4: single shell + track switch). */

export type MediaLibrarySource = "works" | "materials" | "history" | "poses";

export const MEDIA_LIBRARY_PATH = "/library";

/**
 * W5 URL reserve (do NOT use /static):
 * - thumbs = `/api/pose-gallery/thumbs/{file}`
 * - original = `/api/pose-gallery/img/{file}`
 * This wave only reserves the `poses` source enum + empty rail; no PosePicker / no thumbs.
 */
export const POSE_GALLERY_THUMB_PATH = "/api/pose-gallery/thumbs";
export const POSE_GALLERY_IMG_PATH = "/api/pose-gallery/img";

export function mediaLibraryHref(source: MediaLibrarySource = "works"): string {
    if (source === "materials") return `${MEDIA_LIBRARY_PATH}?source=materials`;
    if (source === "history") return `${MEDIA_LIBRARY_PATH}?source=history`;
    if (source === "poses") return `${MEDIA_LIBRARY_PATH}?source=poses`;
    return `${MEDIA_LIBRARY_PATH}?source=works`;
}

export function mediaLibraryWorksDetailPath(boardId: string): string {
    return `${MEDIA_LIBRARY_PATH}/works/${encodeURIComponent(boardId)}`;
}

/** Accept `source=` (new) or legacy `tab=history|personal`. Default works. */
export function parseMediaLibrarySource(value: string | null | undefined): MediaLibrarySource {
    if (value === "materials" || value === "personal") return "materials";
    if (value === "history") return "history";
    if (value === "poses") return "poses";
    if (value === "works") return "works";
    return "works";
}
