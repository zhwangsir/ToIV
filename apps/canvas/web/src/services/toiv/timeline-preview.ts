/**
 * Studio timeline preview contract (Wave8 P0).
 * GET /api/studio/projects/{pid}/timeline-preview
 * (toivHttp baseURL=/api → path `/studio/projects/{pid}/timeline-preview`)
 *
 * Server already filters NSFW items when content_mode=ordinary.
 * UI MUST NOT fetch-all-then-hide — trust the response as the listable set.
 * Do not invent media paths outside preview_url / media_url from this payload.
 */
import { toivHttp } from "@/services/toiv/client";
import type { AccountContentMode } from "@/redline";

export type TimelinePreviewKind = "video" | "audio" | "image" | "text";

export type TimelinePreviewItem = {
    shot_id: string;
    idx: number;
    kind: TimelinePreviewKind | string | null;
    preview_url: string;
    media_url?: string;
    duration_sec: number;
    nsfw: boolean;
};

export type TimelinePreviewResponse = {
    fps: number;
    content_mode: AccountContentMode | string;
    items: TimelinePreviewItem[];
};

const MOCK_SEED: TimelinePreviewItem[] = [
    {
        shot_id: "shot-demo-01",
        idx: 0,
        kind: "video",
        preview_url: "",
        media_url: "",
        duration_sec: 4.5,
        nsfw: false,
    },
    {
        shot_id: "shot-demo-02",
        idx: 1,
        kind: "video",
        preview_url: "",
        media_url: "",
        duration_sec: 6.0,
        nsfw: false,
    },
    {
        shot_id: "shot-demo-03",
        idx: 2,
        kind: "audio",
        preview_url: "",
        duration_sec: 10.5,
        nsfw: false,
    },
    {
        shot_id: "shot-demo-nsfw",
        idx: 3,
        kind: "video",
        preview_url: "",
        duration_sec: 3.2,
        nsfw: true,
    },
];

/** Server-shaped mock: ordinary mode drops nsfw items (mirrors backend filter). */
export function mockTimelinePreview(contentMode: AccountContentMode | string = "ordinary"): TimelinePreviewResponse {
    const mode = contentMode === "adult" ? "adult" : "ordinary";
    const items =
        mode === "adult"
            ? MOCK_SEED.map((item, idx) => ({ ...item, idx }))
            : MOCK_SEED.filter((item) => !item.nsfw).map((item, idx) => ({ ...item, idx }));
    return { fps: 24, content_mode: mode, items };
}

function normalizeResponse(data: Partial<TimelinePreviewResponse> | null | undefined): TimelinePreviewResponse {
    // Trust server filter — do NOT strip by nsfw here.
    const items = Array.isArray(data?.items) ? data!.items : [];
    return {
        fps: typeof data?.fps === "number" && data.fps > 0 ? data.fps : 24,
        content_mode: data?.content_mode ?? "ordinary",
        items: items.map((item, i) => ({
            shot_id: String(item.shot_id ?? `shot-${i}`),
            idx: typeof item.idx === "number" ? item.idx : i,
            kind: item.kind ?? null,
            preview_url: typeof item.preview_url === "string" ? item.preview_url : "",
            ...(typeof item.media_url === "string" && item.media_url ? { media_url: item.media_url } : {}),
            duration_sec: typeof item.duration_sec === "number" ? item.duration_sec : Number(item.duration_sec) || 0,
            nsfw: Boolean(item.nsfw),
        })),
    };
}

export type FetchTimelinePreviewOptions = {
    signal?: AbortSignal;
    /** Force mock (no network). Default: false when projectId present. */
    useMock?: boolean;
    /** Only used by mock fallback when API unreachable / no pid. */
    contentMode?: AccountContentMode | string;
};

/**
 * Prefer live API when `projectId` is set. On network/4xx/5xx, fall back to
 * mock shaped like the contract — still server-filter semantics for ordinary.
 */
export async function fetchTimelinePreview(
    projectId: string,
    options?: FetchTimelinePreviewOptions,
): Promise<TimelinePreviewResponse> {
    const pid = (projectId || "").trim();
    if (options?.useMock || !pid) {
        return mockTimelinePreview(options?.contentMode ?? "ordinary");
    }
    try {
        const { data } = await toivHttp.get<TimelinePreviewResponse>(
            `/studio/projects/${encodeURIComponent(pid)}/timeline-preview`,
            { signal: options?.signal },
        );
        return normalizeResponse(data);
    } catch {
        // API unreachable locally — keep tip usable with mock fallback.
        return mockTimelinePreview(options?.contentMode ?? "ordinary");
    }
}
