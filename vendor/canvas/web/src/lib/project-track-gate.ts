/**
 * W6 F4：项目双轨门禁（文案 + 入口约定）。
 * 短剧管线 ↔ 自由画布/托管项目 分轨，避免双入口混淆。
 */

/** 短剧唯一工作面：列表 /toiv/drama → 密台 /create?project= */
export const SHORT_DRAMA_ENTRY = "/toiv/drama";
export const shortDramaCreateHref = (projectId: string, section = "script") =>
    `/create?project=${encodeURIComponent(projectId)}&section=${encodeURIComponent(section)}`;

/** 自由画布库（专家面；侧栏「高级」深处） */
export const FREE_CANVAS_LIBRARY = "/project";
export const FREE_CANVAS_NEW = "/canvas?mode=new";

/** 托管/自由项目详情轨（非短剧密台） */
export const hostedProjectHref = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const PROJECT_TRACK_GATE = {
    canvasLibraryDescription:
        "本页是自由画布专家轨。短剧请走侧栏「短剧项目」→ 创作台 /create?project=；勿与本库混用。",
    projectDetailHint:
        "托管/自由项目工作台（可建项目画布）。短剧密台请走 /create?project=，与本轨分轨。",
    homeRecentLabel: "最近自由画布（专家）",
    homeRecentAll: "查看画布库",
    advancedNavHeading: "高级 / 专家面",
} as const;
