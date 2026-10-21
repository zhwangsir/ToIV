/**
 * Wave P2 残余：选优 / QA / 声画阶段失败专属人话（在通用 caught error 之上）。
 * 不暴露端口与 worker URL。
 */

function detailOf(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
        return detail.map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d))).join("; ");
    }
    return "";
}

function statusOf(error: unknown): number | undefined {
    return (error as { response?: { status?: number } })?.response?.status;
}

export type StudioQaKind =
    | "pick"
    | "render"
    | "voice"
    | "lipsync"
    | "lipsync_skip"
    | "assemble"
    | "batch"
    | "generic";

const TABLE: Array<{ kind: StudioQaKind | "*"; re: RegExp; message: string }> = [
    { kind: "pick", re: /候选|candidate|not found|不存在|已失效/i, message: "选用候选失败：该候选可能已失效，请刷新后重选，或重新渲染本镜。" },
    { kind: "pick", re: /无.*视频|no video|empty/i, message: "选用候选失败：候选尚无可用视频，请等渲染完成后再选。" },
    { kind: "render", re: /定妆|reference|参考图|makeup/i, message: "生成被拦住：请先完成角色定妆参考图，再开拍。" },
    { kind: "render", re: /503|资源|VRAM|hold|排队/i, message: "视频引擎忙碌或资源不足，任务已排队/等待，可稍后再看任务中心。" },
    { kind: "voice", re: /无台词|no dialogue|dialogue/i, message: "该镜无台词，已可跳过配音；有对白的镜头再点配音。" },
    { kind: "voice", re: /503|TTS|配音服务|不可达|timeout/i, message: "配音服务暂不可用，可先完成分镜与出视频，稍后再配音。" },
    { kind: "lipsync", re: /未配音|voice_url|无配音/i, message: "请先完成本镜配音，再对口型；也可确认后跳过口型直接用于合成。" },
    { kind: "lipsync", re: /9103|LatentSync|对口型引擎|lipsync/i, message: "对口型服务暂不可用。可稍后重试，或确认后跳过口型（成片将标「未对口型」）。" },
    { kind: "lipsync_skip", re: /无视频|无配音/i, message: "跳过口型需要本镜已有视频和配音，请先完成前两步。" },
    { kind: "assemble", re: /缺.*成片|final_clip|未就绪/i, message: "还有镜头未就绪成片段，请先完成生成/配音/口型（或确认跳过口型）。" },
    { kind: "assemble", re: /缺音轨|音轨/i, message: "成片段缺音轨，请重跑对口型或「跳过口型」以写入配音。" },
    { kind: "batch", re: /定妆|参考图/i, message: "整批渲染前请先完成定妆；未定妆的项目会被拦住。" },
    { kind: "*", re: /401|未登录|鉴权/i, message: "登录已失效，请重新登录后再试。" },
    { kind: "*", re: /403|权限/i, message: "没有权限执行该操作。" },
    { kind: "*", re: /429|限流|rate/i, message: "请求过于频繁，请稍后再试。" },
];

/**
 * 在通用 fallback 之上叠加选优/声画专属人话。
 * 匹配不上则返回 fallback（通常已是 userFacingCaughtError 结果）。
 */
export function studioQaHumanMessage(kind: StudioQaKind, error: unknown, fallback: string): string {
    const raw = detailOf(error);
    const status = statusOf(error);
    const hay = `${raw} ${fallback}`.trim();
    for (const row of TABLE) {
        if (row.kind !== "*" && row.kind !== kind) continue;
        if (row.re.test(hay)) return row.message;
    }
    if (status === 503) {
        if (kind === "voice") return "配音服务暂不可用，可先完成分镜与出视频，稍后再配音。";
        if (kind === "render" || kind === "batch") return "视频引擎忙碌或资源不足，请稍后在任务中心查看进度。";
        if (kind === "lipsync") return "对口型服务暂不可用，可稍后重试或确认后跳过口型。";
    }
    if (status === 422 && kind === "pick") {
        return raw ? `选用候选失败：${raw}` : "选用候选失败，请刷新后重试。";
    }
    return fallback;
}
