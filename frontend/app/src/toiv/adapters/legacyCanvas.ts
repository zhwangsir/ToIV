import { toivMediaUrl } from "./media";

export type PrimeLegacyNode = {
    id: string;
    kind: string;
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
    src?: string;
    poster?: string;
    excerpt?: string;
};

export type PrimeLegacyEdge = { id: string; source: string; target: string };

export type PrimeLegacyCanvas = {
    id: string;
    title: string;
    updatedAt: string;
    nodes: PrimeLegacyNode[];
    edges: PrimeLegacyEdge[];
};

type RawNode = {
    id?: unknown;
    type?: unknown;
    title?: unknown;
    position?: { x?: unknown; y?: unknown };
    width?: unknown;
    height?: unknown;
    metadata?: { content?: unknown; previewContent?: unknown; videoPreview?: { content?: unknown } };
};

type RawProject = {
    id?: unknown;
    title?: unknown;
    canvasTitle?: unknown;
    updatedAt?: unknown;
    nodes?: unknown;
    connections?: unknown;
};

const TEXT_KINDS = new Set(["text", "script", "markdown", "skill", "config", "prompt"]);
const IMAGE_KINDS = new Set(["image", "drawing", "svg", "chart", "compare", "colorgrade", "panorama"]);

function finite(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** Only same-origin API media, absolute HTTP(S) or an inline image; never javascript:/blob: sources. */
function safeMedia(value: unknown, expected: "image" | "video"): string | undefined {
    const raw = text(value);
    if (!raw) return undefined;
    if (raw.startsWith(`data:${expected}/`)) return raw;
    const url = toivMediaUrl(raw);
    if (!url) return undefined;
    return url;
}

function excerpt(value: unknown): string | undefined {
    const raw = text(value);
    if (!raw || /^(?:[a-z]+:|\/)/i.test(raw)) return undefined;
    return raw.length > 180 ? `${raw.slice(0, 180)}…` : raw;
}

export function normalizeLegacyCanvas(raw: RawProject): PrimeLegacyCanvas {
    const nodes: PrimeLegacyNode[] = (Array.isArray(raw.nodes) ? raw.nodes : [])
        .map((item): PrimeLegacyNode | null => {
            const node = item as RawNode;
            const id = text(node.id);
            if (!id) return null;
            const kind = text(node.type) || "unknown";
            const metadata = node.metadata ?? {};
            const isVideo = kind === "video";
            const isImage = IMAGE_KINDS.has(kind);
            const src = isVideo
                ? safeMedia(metadata.content, "video")
                : isImage ? safeMedia(metadata.content, "image") ?? safeMedia(metadata.previewContent, "image") : undefined;
            const poster = isVideo ? safeMedia(metadata.videoPreview?.content, "image") : undefined;
            return {
                id,
                kind,
                title: text(node.title) || kind,
                x: finite(node.position?.x, 0),
                y: finite(node.position?.y, 0),
                width: clamp(finite(node.width, 240), 120, 520),
                height: clamp(finite(node.height, 150), 80, 420),
                ...(src ? { src } : {}),
                ...(poster ? { poster } : {}),
                ...(TEXT_KINDS.has(kind) ? { excerpt: excerpt(metadata.content) } : {}),
            };
        })
        .filter((node): node is PrimeLegacyNode => node !== null);

    const ids = new Set(nodes.map((node) => node.id));
    const edges: PrimeLegacyEdge[] = (Array.isArray(raw.connections) ? raw.connections : [])
        .map((item, index): PrimeLegacyEdge | null => {
            const connection = item as { id?: unknown; fromNodeId?: unknown; toNodeId?: unknown };
            const source = text(connection.fromNodeId);
            const target = text(connection.toNodeId);
            if (!ids.has(source) || !ids.has(target)) return null;
            return { id: text(connection.id) || `${source}->${target}:${index}`, source, target };
        })
        .filter((edge): edge is PrimeLegacyEdge => edge !== null);

    return {
        id: text(raw.id),
        title: text(raw.canvasTitle) || text(raw.title) || text(raw.id),
        updatedAt: text(raw.updatedAt),
        nodes,
        edges,
    };
}

export async function loadLegacyCanvas(id: string): Promise<PrimeLegacyCanvas> {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    const response = await fetch(`/studio/api/canvas-projects/${encodeURIComponent(id)}`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (response.status === 401 || response.status === 403) throw new Error("无权访问这块画布");
    if (response.status === 404) throw new Error("画布不存在或已被删除");
    if (!response.ok) throw new Error(`画布载入失败 (${response.status})`);
    const body = await response.json().catch(() => null) as { code?: number; data?: { project?: RawProject }; msg?: string } | null;
    if (body?.code !== 0 || !body.data?.project) {
        throw new Error(body?.code === 403 ? "无权访问这块画布" : "画布响应异常");
    }
    return normalizeLegacyCanvas(body.data.project);
}
