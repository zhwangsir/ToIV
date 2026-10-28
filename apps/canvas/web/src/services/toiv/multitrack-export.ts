/**
 * P2-9：创作台时间轴导出（EDL / FCPXML / 多轨包）——前端契约与解析。
 * 协议实现在后端 `export_timeline.py`；响应头带 X-Toiv-Export-Format /
 * X-Toiv-Missing-Assets / X-Toiv-Duration-Issues（多轨另带 X-Toiv-Video-Clips）。
 * 下载复用 jianying-draft 的 triggerBlobDownload / parseContentDispositionFilename。
 */
import { toivHttp } from "./client";
import { parseContentDispositionFilename } from "./jianying-draft";

export type StudioExportAction = "jianying" | "edl" | "fcpxml" | "multitrack";

export const STUDIO_EXPORT_ACTION_LABELS: Record<StudioExportAction, string> = {
    jianying: "剪映草稿",
    edl: "EDL 剪辑表",
    fcpxml: "FCPXML 工程",
    multitrack: "多轨导出包",
};

/** 无成片片段时的禁用提示（要求先完成 final_clip） */
export const STUDIO_EXPORT_NO_CLIPS_HINT = "暂无成片片段，请先完成 final_clip（或合成成片）";

export const STUDIO_EXPORT_HINT =
    "剪映为 best-effort 明文草稿（见包内 IMPORT.md）；EDL/FCPXML 可导入主流剪辑软件；多轨包含切点清单与缺素材/时长问题回执。";

export type StudioTimelineExportResult = {
    blob: Blob;
    fileName: string;
    /** X-Toiv-Export-Format 原样透出（如 toiv_multitrack_export_v1） */
    format: string;
    /** X-Toiv-Missing-Assets */
    missingAssets: number;
    /** X-Toiv-Duration-Issues */
    durationIssues: number;
    /** X-Toiv-Video-Clips（仅多轨包带；其余 null） */
    videoClips: number | null;
};

export type StudioExportMenuItem = {
    key: StudioExportAction;
    label: string;
    disabled: boolean;
    /** 禁用原因（展示用） */
    hint?: string;
};

/**
 * 导出下拉动作模型（纯函数，供组件与单测共用文案/禁用条件）。
 * 无成片片段（ready=false）或导出进行中 → 全部动作禁用。
 */
export function studioExportMenuModel(opts: { ready: boolean; busy?: boolean }): StudioExportMenuItem[] {
    return (Object.keys(STUDIO_EXPORT_ACTION_LABELS) as StudioExportAction[]).map((key) => ({
        key,
        label: STUDIO_EXPORT_ACTION_LABELS[key],
        disabled: !opts.ready || Boolean(opts.busy),
        hint: !opts.ready ? STUDIO_EXPORT_NO_CLIPS_HINT : undefined,
    }));
}

function readHeader(headers: unknown, name: string): string {
    if (!headers || typeof headers !== "object") return "";
    const getter = (headers as { get?: (key: string) => unknown }).get;
    if (typeof getter === "function") {
        const viaGet = getter.call(headers, name);
        if (typeof viaGet === "string") return viaGet;
    }
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === lower) {
            const value = (headers as Record<string, unknown>)[key];
            if (typeof value === "string") return value;
        }
    }
    return "";
}

function parseCount(raw: string): number {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 解析 X-Toiv-* 导出回执头（缺素材/时长问题计数）；缺项/非法 → 0 */
export function parseExportIssueCounts(headers: unknown): {
    format: string;
    missingAssets: number;
    durationIssues: number;
    videoClips: number | null;
} {
    const clipsRaw = readHeader(headers, "x-toiv-video-clips");
    return {
        format: readHeader(headers, "x-toiv-export-format"),
        missingAssets: parseCount(readHeader(headers, "x-toiv-missing-assets")),
        durationIssues: parseCount(readHeader(headers, "x-toiv-duration-issues")),
        videoClips: clipsRaw ? parseCount(clipsRaw) : null,
    };
}

async function bodyToText(data: unknown): Promise<string> {
    if (typeof data === "string") return data;
    if (data instanceof Blob) return await data.text();
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as unknown as ArrayBufferView);
    if (data && typeof data === "object") return JSON.stringify(data);
    return "";
}

function detailFromText(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
        const detail = (JSON.parse(trimmed) as { detail?: unknown })?.detail;
        if (typeof detail === "string" && detail.trim()) return detail.trim();
    } catch {
        /* 非 JSON 正文 */
    }
    return null;
}

function toBlob(data: unknown, contentType: string): Blob {
    const options = contentType ? { type: contentType } : undefined;
    if (data instanceof Blob) return data;
    if (data instanceof ArrayBuffer) return new Blob([data], options);
    if (ArrayBuffer.isView(data)) return new Blob([data as unknown as BlobPart], options);
    return new Blob([typeof data === "string" ? data : ""], options);
}

async function normalizeExportError(e: unknown, label: string): Promise<Error> {
    const response = (e as { response?: { data?: unknown } })?.response;
    if (response) {
        const detail = detailFromText(await bodyToText(response.data));
        if (detail) return new Error(detail);
    }
    if (e instanceof Error && e.message && !/^Request failed with status code/i.test(e.message)) return e;
    return new Error(`${label}失败`);
}

type TimelineExportSpec = {
    /** 相对 toivHttp baseURL 的路径 */
    path: string;
    fallbackFileName: string;
    /** 错误兜底文案前缀（如「EDL 导出」→「EDL 导出失败」） */
    label: string;
    timeout: number;
};

async function fetchTimelineExport(pid: string, spec: TimelineExportSpec): Promise<StudioTimelineExportResult> {
    try {
        const { data, headers } = await toivHttp.get(
            `/studio/projects/${encodeURIComponent(pid)}/${spec.path}`,
            { responseType: "arraybuffer", timeout: spec.timeout },
        );
        const contentType = readHeader(headers, "content-type");
        // 导出成功为 text/plain / x-fcpxml / zip；JSON 一律是错误体（含 200 误回 JSON）
        if (contentType.includes("application/json")) {
            const detail = detailFromText(await bodyToText(data));
            throw new Error(detail || `${spec.label}失败`);
        }
        const fileName = parseContentDispositionFilename(
            readHeader(headers, "content-disposition"),
            spec.fallbackFileName,
        );
        const counts = parseExportIssueCounts(headers);
        return { blob: toBlob(data, contentType), fileName, ...counts };
    } catch (e) {
        throw await normalizeExportError(e, spec.label);
    }
}

/** GET /studio/projects/{pid}/export/edl —— CMX3600 EDL 文本 */
export async function exportStudioTimelineEdl(pid: string): Promise<StudioTimelineExportResult> {
    return fetchTimelineExport(pid, {
        path: "export/edl",
        fallbackFileName: "timeline.edl",
        label: "EDL 导出",
        timeout: 60_000,
    });
}

/** GET /studio/projects/{pid}/export/fcpxml —— FCPXML 工程文本 */
export async function exportStudioTimelineFcpxml(pid: string): Promise<StudioTimelineExportResult> {
    return fetchTimelineExport(pid, {
        path: "export/fcpxml",
        fallbackFileName: "timeline.fcpxml",
        label: "FCPXML 导出",
        timeout: 60_000,
    });
}

/** GET /studio/projects/{pid}/export/multitrack —— 多轨 ZIP（EDL+FCPXML+manifest/切点/缺素材/时长清单） */
export async function exportStudioMultitrackBundle(pid: string): Promise<StudioTimelineExportResult> {
    return fetchTimelineExport(pid, {
        path: "export/multitrack",
        fallbackFileName: "timeline_multitrack.zip",
        label: "多轨导出",
        timeout: 600_000,
    });
}
