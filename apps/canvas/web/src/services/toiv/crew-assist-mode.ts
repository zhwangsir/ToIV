/**
 * D5-A 剧组协助模式（IA_INTERACTION_SPEC §3.4 / COMPETITIVE D5-A）。
 *
 * 默认关：阶段轨人手推进。开启后露出轻提示 + F2 专家「一键成片」入口
 * （见 crew-one-click.ts → createAgentRun → agent_team_graph）。
 * 三点人闸（定妆选角、过脸/VLM、合成 assembly_gate / 计划确认门）仍强制；
 * 开关本身**不**自动建 run；一键成片须用户再点，且不 auto-approve。
 * UI-only：localStorage，无后端表。
 */
const GLOBAL_KEY = "toiv_crew_assist";
const projectKey = (projectId: string) => `toiv_crew_assist:${projectId}`;

export function isCrewAssistMode(projectId?: string | null): boolean {
    if (typeof window === "undefined") return false;
    if (projectId) {
        const scoped = window.localStorage.getItem(projectKey(projectId));
        if (scoped === "1") return true;
        if (scoped === "0") return false;
    }
    return window.localStorage.getItem(GLOBAL_KEY) === "1";
}

export function setCrewAssistMode(on: boolean, projectId?: string | null): void {
    if (typeof window === "undefined") return;
    const value = on ? "1" : "0";
    if (projectId) {
        window.localStorage.setItem(projectKey(projectId), value);
        return;
    }
    if (on) window.localStorage.setItem(GLOBAL_KEY, "1");
    else window.localStorage.removeItem(GLOBAL_KEY);
}

/** 开启时挂在人闸旁的轻提示（不触发任何自动推进）。 */
export const CREW_ASSIST_GATE_HINT =
    "剧组协助已开：三点人闸（定妆选角 · 过脸/门禁 · 合成）仍须人手确认；一键成片仅建计划，确认门仍在详情页，不会自动越过。";
