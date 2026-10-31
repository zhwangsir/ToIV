import {
    generateUpscale,
    pollGenJob,
    toivHttp,
    uploadToivImage,
    uploadToivMedia,
} from "./client";
import { formatClientTimeoutMessage } from "./client-timeout";

/**
 * F10 超分入口:创作工作区选中媒体一键提交 ToIV 超分 fleet。
 *
 * 图片:blob → POST /api/upload(img2img)→ POST /api/generate/upscale
 *       (ESRGAN/4x-UltraSharp,scale 2/4)→ 轮询 /api/jobs 取产物;
 *       产物自动收录 ToIV 作品库。
 * 视频:blob → POST /api/upload → POST /api/video/upscale(秒回 Job,
 *       target=4k,engine=classic)→ 后台管线抽帧超分,完成后自动收录
 *       作品库(kind=video_upscale),进度在任务中心查看。
 *       video_url 走 /api/images?…&type=input 白名单形态(上传件在 input 目录)。
 *
 * 全部经既有 toivHttp 封装(同源 /api,带 toiv_token;P-20:不自拼绝对地址)。
 */

export type ToivVideoUpscaleAck = { job_id: string; prompt_id: string; target: string; engine: string };

const IMAGE_EXT_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
};

const VIDEO_EXT_BY_MIME: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
};

/** 上传文件名(服务端按扩展名+魔数三重白名单校验,扩展名必须与真实内容一致)。 */
export function upscaleUploadFilename(mime: string, kind: "image" | "video", base = "creation-result"): string {
    const table = kind === "video" ? VIDEO_EXT_BY_MIME : IMAGE_EXT_BY_MIME;
    const ext = table[(mime || "").split(";")[0].trim().toLowerCase()] || (kind === "video" ? "mp4" : "png");
    return `${base}-${Date.now().toString(36)}.${ext}`;
}

/** 上传件的视频超分源 URL:/api/images 白名单形态,input 目录,worker 由服务端解析(SSRF 白名单)。 */
export function toivUploadedVideoUrl(filename: string, worker: string): string {
    const qs = new URLSearchParams({ filename, worker, type: "input" });
    return `/api/images?${qs.toString()}`;
}

async function fetchMediaBlob(url: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(url, { signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(`读取媒体失败(HTTP ${response.status})`);
    return await response.blob();
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}

/** 轮询生成作业直到终态;done 返回产物路径数组(签名 URL 由 toivMediaUrl 再加 token)。 */
export async function pollToivJobUntilDone(
    promptId: string,
    opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<string[]> {
    const intervalMs = Math.max(1000, opts?.intervalMs ?? 3000);
    const timeoutMs = Math.max(intervalMs, opts?.timeoutMs ?? 600_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const job = await pollGenJob(promptId);
        if (job) {
            if (job.status === "done") return job.results;
            if (job.status === "error" || job.status === "canceled") {
                throw new Error(job.status === "canceled" ? "超分作业已取消" : job.hold_reason || "超分失败(可在任务中心查看详情)");
            }
        }
        if (Date.now() >= deadline) throw new Error(formatClientTimeoutMessage());
        await delay(intervalMs, opts?.signal);
    }
}

/** 图片一键超分:上传 → 提交 fleet → 轮询到产物;返回产物相对路径数组。 */
export async function upscaleImageViaToiv(
    sourceUrl: string,
    opts?: { scale?: number; signal?: AbortSignal; pollIntervalMs?: number; pollTimeoutMs?: number },
): Promise<string[]> {
    const blob = await fetchMediaBlob(sourceUrl, opts?.signal);
    if (!blob.size) throw new Error("媒体内容为空,无法超分");
    const file = new File([blob], upscaleUploadFilename(blob.type, "image"), { type: blob.type || "image/png" });
    const handle = await uploadToivImage(file, "img2img");
    const ack = await generateUpscale({ image: handle.filename, worker: handle.worker, scale: opts?.scale ?? 2 });
    if (!ack?.prompt_id) throw new Error("超分提交失败:服务端未返回作业号");
    return await pollToivJobUntilDone(ack.prompt_id, { signal: opts?.signal, intervalMs: opts?.pollIntervalMs, timeoutMs: opts?.pollTimeoutMs });
}

/** 视频一键超分:上传 → 提交 4K 超分作业(秒回);产物由后台管线完成后自动收录作品库。 */
export async function submitVideoUpscaleViaToiv(
    sourceUrl: string,
    opts?: { target?: string; engine?: string; signal?: AbortSignal },
): Promise<ToivVideoUpscaleAck> {
    const blob = await fetchMediaBlob(sourceUrl, opts?.signal);
    if (!blob.size) throw new Error("媒体内容为空,无法超分");
    const file = new File([blob], upscaleUploadFilename(blob.type, "video"), { type: blob.type || "video/mp4" });
    const uploaded = await uploadToivMedia(file, "img2img", undefined, {});
    const { data } = await toivHttp.post(
        "/video/upscale",
        { video_url: toivUploadedVideoUrl(uploaded.filename, uploaded.worker), target: opts?.target ?? "4k", engine: opts?.engine ?? "classic" },
        { timeout: 60_000, signal: opts?.signal },
    );
    const raw = (data ?? {}) as Record<string, unknown>;
    const jobId = String(raw.job_id ?? "");
    if (!jobId) throw new Error("视频超分提交失败:服务端未返回作业号");
    return { job_id: jobId, prompt_id: String(raw.prompt_id ?? ""), target: String(raw.target ?? "4k"), engine: String(raw.engine ?? "classic") };
}
