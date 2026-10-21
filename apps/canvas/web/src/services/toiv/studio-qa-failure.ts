/**
 * Wave P2 残余 + F1：选优 / QA / 声画失败专属人话 + 结构化失败码表（comfyui-auto-drama 范式）。
 * 不暴露端口与 worker URL。
 */

function detailOf(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
        const d = detail as { message?: unknown; code?: unknown; msg?: unknown };
        const parts = [d.message, d.msg, d.code].filter((x) => typeof x === "string" && x.trim());
        if (parts.length) return parts.map(String).join(" ");
    }
    if (Array.isArray(detail)) {
        return detail.map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d))).join("; ");
    }
    return "";
}

function statusOf(error: unknown): number | undefined {
    return (error as { response?: { status?: number } })?.response?.status;
}

function codeHintOf(error: unknown): string {
    const data = (error as { response?: { data?: { detail?: unknown; code?: unknown } } })?.response?.data;
    if (data && typeof data === "object") {
        const top = (data as { code?: unknown }).code;
        if (typeof top === "string" && top.trim()) return top.trim();
        const detail = (data as { detail?: unknown }).detail;
        if (detail && typeof detail === "object" && !Array.isArray(detail)) {
            const c = (detail as { code?: unknown }).code;
            if (typeof c === "string" && c.trim()) return c.trim();
        }
    }
    if (error && typeof error === "object" && "code" in error) {
        const c = (error as { code?: unknown }).code;
        if (typeof c === "string" && c.trim()) return c.trim();
    }
    return "";
}

export type StudioQaKind =
    | "pick"
    | "render"
    | "voice"
    | "lipsync"
    | "lipsync_skip"
    | "assemble"
    | "batch"
    | "keyframe"
    | "generic";

/** F1 结构化失败码（对外稳定；UI 抽屉 / 质检提示按码检索）。 */
export type StudioFailureCode =
    | "QA_NO_CANDIDATE"
    | "QA_NO_VIDEO"
    | "RENDER_NO_MAKEUP"
    | "RENDER_BUSY"
    | "VOICE_NO_DIALOGUE"
    | "VOICE_UNAVAILABLE"
    | "LIPSYNC_NO_VOICE"
    | "LIPSYNC_UNAVAILABLE"
    | "LIPSYNC_SKIP_PRECOND"
    | "ASSEMBLE_SHOT_NOT_READY"
    | "ASSEMBLE_NO_AUDIO"
    | "BATCH_NO_MAKEUP"
    | "KEYFRAME_REQUIRED"
    | "AUTH_EXPIRED"
    | "FORBIDDEN"
    | "RATE_LIMITED"
    | "UNKNOWN";

export type StudioFailureEntry = {
    code: StudioFailureCode;
    kind: StudioQaKind | "*";
    re: RegExp;
    message: string;
    /** 质检/下一步提示（人话） */
    qaHint: string;
};

export const STUDIO_FAILURE_TABLE: readonly StudioFailureEntry[] = [
    {
        code: "QA_NO_CANDIDATE",
        kind: "pick",
        re: /候选|candidate|not found|不存在|已失效/i,
        message: "选用候选失败：该候选可能已失效，请刷新后重选，或重新渲染本镜。",
        qaHint: "打开任务中心确认本镜候选仍在；失效则单镜重渲。",
    },
    {
        code: "QA_NO_VIDEO",
        kind: "pick",
        re: /无.*视频|no video|empty/i,
        message: "选用候选失败：候选尚无可用视频，请等渲染完成后再选。",
        qaHint: "等渲染状态变为已出视频后再点选用。",
    },
    {
        code: "RENDER_NO_MAKEUP",
        kind: "render",
        re: /定妆|reference|参考图|makeup/i,
        message: "生成被拦住：请先完成角色定妆参考图，再开拍。",
        qaHint: "到「资产/定妆」为出场角色生成并采用设定卡。",
    },
    {
        code: "KEYFRAME_REQUIRED",
        kind: "keyframe",
        re: /关键帧|KEYFRAME_REQUIRED|先帧|配景/i,
        message: "关键帧驱动：请先生成并采用本镜关键帧，再开拍视频。",
        qaHint: "分镜表点「AI 配景」→ 采用一帧；或将驱动改为「直接出视频（专家）」。",
    },
    {
        code: "KEYFRAME_REQUIRED",
        kind: "render",
        re: /关键帧|KEYFRAME_REQUIRED|先帧后视频/i,
        message: "关键帧驱动：请先生成并采用本镜关键帧，再开拍视频。",
        qaHint: "分镜表点「AI 配景」→ 采用一帧；或将驱动改为「直接出视频（专家）」。",
    },
    {
        code: "RENDER_BUSY",
        kind: "render",
        re: /503|资源|VRAM|hold|排队/i,
        message: "视频引擎忙碌或资源不足，任务已排队/等待，可稍后再看任务中心。",
        qaHint: "到任务中心看排队；高峰可稍后重试单镜。",
    },
    {
        code: "VOICE_NO_DIALOGUE",
        kind: "voice",
        re: /无台词|no dialogue|dialogue/i,
        message: "该镜无台词，已可跳过配音；有对白的镜头再点配音。",
        qaHint: "无对白镜会自动越过配音/口型，可继续后续镜头。",
    },
    {
        code: "VOICE_UNAVAILABLE",
        kind: "voice",
        re: /503|TTS|配音服务|不可达|timeout/i,
        message: "配音服务暂不可用，可先完成分镜与出视频，稍后再配音。",
        qaHint: "检查「模型与算力」里配音依赖；恢复后再批量配音。",
    },
    {
        code: "LIPSYNC_NO_VOICE",
        kind: "lipsync",
        re: /未配音|voice_url|无配音/i,
        message: "请先完成本镜配音，再对口型；也可确认后跳过口型直接用于合成。",
        qaHint: "先点配音；若赶进度可用「跳过口型」。",
    },
    {
        code: "LIPSYNC_UNAVAILABLE",
        kind: "lipsync",
        re: /9103|LatentSync|对口型引擎|lipsync/i,
        message: "对口型服务暂不可用。可稍后重试，或确认后跳过口型（成片将标「未对口型」）。",
        qaHint: "依赖恢复后重试；或跳过口型继续合成。",
    },
    {
        code: "LIPSYNC_SKIP_PRECOND",
        kind: "lipsync_skip",
        re: /无视频|无配音/i,
        message: "跳过口型需要本镜已有视频和配音，请先完成前两步。",
        qaHint: "先出视频并配音，再跳过口型。",
    },
    {
        code: "ASSEMBLE_SHOT_NOT_READY",
        kind: "assemble",
        re: /缺.*成片|final_clip|未就绪/i,
        message: "还有镜头未就绪成片段，请先完成生成/配音/口型（或确认跳过口型）。",
        qaHint: "看控片就绪灯：灰灯镜头补齐后再合成。",
    },
    {
        code: "ASSEMBLE_NO_AUDIO",
        kind: "assemble",
        re: /缺音轨|音轨/i,
        message: "成片段缺音轨，请重跑对口型或「跳过口型」以写入配音。",
        qaHint: "对有对白镜补口型或跳过口型以写入音轨。",
    },
    {
        code: "BATCH_NO_MAKEUP",
        kind: "batch",
        re: /定妆|参考图/i,
        message: "整批渲染前请先完成定妆；未定妆的项目会被拦住。",
        qaHint: "至少一名角色完成设定卡采用后再整批。",
    },
    {
        code: "AUTH_EXPIRED",
        kind: "*",
        re: /401|未登录|鉴权/i,
        message: "登录已失效，请重新登录后再试。",
        qaHint: "重新登录后回到本页继续。",
    },
    {
        code: "FORBIDDEN",
        kind: "*",
        re: /403|权限/i,
        message: "没有权限执行该操作。",
        qaHint: "确认账号对该项目有写权限。",
    },
    {
        code: "RATE_LIMITED",
        kind: "*",
        re: /429|限流|rate/i,
        message: "请求过于频繁，请稍后再试。",
        qaHint: "稍等数秒后重试，避免连点整批。",
    },
] as const;

export type StudioFailureResolution = {
    code: StudioFailureCode;
    message: string;
    qaHint: string;
};

function matchTable(kind: StudioQaKind, hay: string): StudioFailureEntry | undefined {
    for (const row of STUDIO_FAILURE_TABLE) {
        if (row.kind !== "*" && row.kind !== kind) continue;
        if (row.re.test(hay)) return row;
    }
    return undefined;
}

/**
 * 解析结构化失败：码 + 人话 + 质检下一步。
 * 匹配不上时 code=UNKNOWN，message=fallback。
 */
export function resolveStudioFailure(
    kind: StudioQaKind,
    error: unknown,
    fallback: string,
): StudioFailureResolution {
    const raw = detailOf(error);
    const status = statusOf(error);
    const explicit = codeHintOf(error).toUpperCase();
    const hay = `${explicit} ${raw} ${fallback}`.trim();

    if (explicit === "KEYFRAME_REQUIRED") {
        const row = STUDIO_FAILURE_TABLE.find((r) => r.code === "KEYFRAME_REQUIRED");
        return {
            code: "KEYFRAME_REQUIRED",
            message: row?.message || fallback,
            qaHint: row?.qaHint || "",
        };
    }

    const hit = matchTable(kind, hay);
    if (hit) {
        return { code: hit.code, message: hit.message, qaHint: hit.qaHint };
    }

    if (status === 503) {
        if (kind === "voice") {
            return {
                code: "VOICE_UNAVAILABLE",
                message: "配音服务暂不可用，可先完成分镜与出视频，稍后再配音。",
                qaHint: "检查配音依赖后重试。",
            };
        }
        if (kind === "render" || kind === "batch") {
            return {
                code: "RENDER_BUSY",
                message: "视频引擎忙碌或资源不足，请稍后在任务中心查看进度。",
                qaHint: "到任务中心查看排队。",
            };
        }
        if (kind === "lipsync") {
            return {
                code: "LIPSYNC_UNAVAILABLE",
                message: "对口型服务暂不可用，可稍后重试或确认后跳过口型。",
                qaHint: "恢复后重试或跳过口型。",
            };
        }
    }
    if (status === 422 && kind === "pick") {
        return {
            code: "QA_NO_CANDIDATE",
            message: raw ? `选用候选失败：${raw}` : "选用候选失败，请刷新后重试。",
            qaHint: "刷新候选列表后重选。",
        };
    }
    return { code: "UNKNOWN", message: fallback, qaHint: "" };
}

/** 按码取质检提示（抽屉/文档用）。 */
export function studioFailureQaHint(code: StudioFailureCode): string {
    const row = STUDIO_FAILURE_TABLE.find((r) => r.code === code);
    return row?.qaHint || "";
}

/**
 * 在通用 fallback 之上叠加选优/声画专属人话。
 * 匹配不上则返回 fallback（通常已是 userFacingCaughtError 结果）。
 */
export function studioQaHumanMessage(kind: StudioQaKind, error: unknown, fallback: string): string {
    return resolveStudioFailure(kind, error, fallback).message;
}

/** 人话 + 质检提示拼成一条（控片/抽屉展示）。 */
export function studioQaMessageWithHint(kind: StudioQaKind, error: unknown, fallback: string): string {
    const r = resolveStudioFailure(kind, error, fallback);
    if (!r.qaHint) return r.message;
    return `${r.message}（下一步：${r.qaHint}）`;
}
