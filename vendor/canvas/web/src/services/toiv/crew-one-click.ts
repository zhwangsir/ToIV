/**
 * F2 / P4：剧组「一键成片」专家入口。
 *
 * 契约：仅在 D5-A 剧组协助开启时可触发；调用既有 createAgentRun →
 * agent_team_graph（计划确认门在图外，合成门 assembly_gate interrupt）。
 * **绝不**自动放行确认门，人闸仍在 /toiv/runs/:id 详情页确认。
 */
import { createAgentRun, type AgentRunCreateResult } from "./agent-runs";
import { isCrewAssistMode } from "./crew-assist-mode";

/** 挂在按钮旁的专家路径说明（人闸强制）。 */
export const CREW_ONE_CLICK_EXPERT_HINT =
    "专家路径：一键只建 Agent Team 计划，定妆/计划确认/合成门仍须人手；不会自动越过人闸。";

/** 按钮文案（短）。 */
export const CREW_ONE_CLICK_LABEL = "一键成片";

/** 按钮 title / aria 完整说明。 */
export const CREW_ONE_CLICK_TITLE =
    "专家·一键成片：创建 Agent Team 运行并打开计划确认；三点人闸仍强制";

export class CrewOneClickGateError extends Error {
    readonly code: "CREW_ASSIST_OFF" | "EMPTY_GOAL" | "L0_REJECTED";

    constructor(code: CrewOneClickGateError["code"], message: string) {
        super(message);
        this.name = "CrewOneClickGateError";
        this.code = code;
    }
}

export interface CrewOneClickProject {
    id: string;
    title?: string | null;
    premise?: string | null;
    style?: string | null;
    preferred_pipeline?: string | null;
}

/** 从短剧项目拼 Agent Team goal（含「短剧」关键词，便于 L2 分流）。 */
export function buildCrewOneClickGoal(project: CrewOneClickProject): string {
    const title = (project.title ?? "").trim() || "未命名短剧";
    const premise = (project.premise ?? "").trim();
    const parts = [`短剧《${title}》一键成片（专家路径，人闸确认后执行）`];
    if (premise) parts.push(premise);
    else parts.push("请根据标题规划分镜与成片管线。");
    return parts.join("\n\n").slice(0, 20000);
}

export function crewOneClickRunPath(runId: string): string {
    return `/toiv/runs/${encodeURIComponent(runId)}`;
}

export interface CrewOneClickResult {
    runId: string;
    level: "L1" | "L2";
    ack: string;
    goal: string;
    /** 始终 false：本入口不代过任何确认门 */
    autoApproved: false;
}

/**
 * 专家一键：校验剧组协助 → createAgentRun(L2) → 返回 runId。
 * 不调用确认门放行 API，不代 approve。
 */
export async function startCrewOneClick(
    project: CrewOneClickProject,
    deps?: {
        createRun?: typeof createAgentRun;
        isAssistOn?: (projectId?: string | null) => boolean;
    },
): Promise<CrewOneClickResult> {
    const assistOn = deps?.isAssistOn ?? isCrewAssistMode;
    if (!assistOn(project.id)) {
        throw new CrewOneClickGateError(
            "CREW_ASSIST_OFF",
            "请先打开「剧组协助」再使用专家一键成片",
        );
    }
    const goal = buildCrewOneClickGoal(project);
    if (!goal.trim()) {
        throw new CrewOneClickGateError("EMPTY_GOAL", "缺少可用剧本/标题，无法建 Agent Team");
    }
    const create = deps?.createRun ?? createAgentRun;
    const result: AgentRunCreateResult = await create({
        goal,
        level: "L2",
        opts: {
            source: "crew_one_click",
            source_project_id: project.id,
            style: project.style || "",
            preferred_pipeline: project.preferred_pipeline || "",
            human_gates: ["plan", "assembly", "makeup"],
            auto_approve: false,
        },
    });
    if (result.level === "L0" || !result.run_id) {
        throw new CrewOneClickGateError(
            "L0_REJECTED",
            result.level === "L0"
                ? result.ack || "已判为单步任务，未建 Agent Team"
                : "创建未返回 run_id",
        );
    }
    return {
        runId: result.run_id,
        level: result.level,
        ack: result.ack,
        goal,
        autoApproved: false,
    };
}
