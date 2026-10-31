import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { setCrewAssistMode } from "../src/services/toiv/crew-assist-mode";
import {
    CREW_ONE_CLICK_EXPERT_HINT,
    CREW_ONE_CLICK_LABEL,
    CREW_ONE_CLICK_TITLE,
    CrewOneClickGateError,
    buildCrewOneClickGoal,
    crewOneClickRunPath,
    startCrewOneClick,
} from "../src/services/toiv/crew-one-click";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function installMemoryStorage() {
    const store = new Map<string, string>();
    const ls = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => store.clear(),
    };
    const prevWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { localStorage: ls },
    });
    return () => {
        if (prevWindow === undefined) {
            // @ts-expect-error cleanup
            delete globalThis.window;
        } else {
            Object.defineProperty(globalThis, "window", { configurable: true, value: prevWindow });
        }
    };
}

describe("F2 crew-one-click service", () => {
    let restore: () => void;

    beforeEach(() => {
        restore = installMemoryStorage();
    });

    afterEach(() => {
        restore();
    });

    test("goal 含短剧关键词与标题/premise", () => {
        const goal = buildCrewOneClickGoal({
            id: "p1",
            title: "雨夜",
            premise: "便利店门口对峙",
        });
        expect(goal).toContain("短剧");
        expect(goal).toContain("雨夜");
        expect(goal).toContain("便利店门口对峙");
        expect(goal).toContain("人闸");
    });

    test("run 路径钉 /toiv/runs/:id", () => {
        expect(crewOneClickRunPath("abc/def")).toBe("/toiv/runs/abc%2Fdef");
    });

    test("剧组协助关 → CREW_ASSIST_OFF，不调 createRun", async () => {
        const createRun = mock(async () => {
            throw new Error("should not call");
        });
        await expect(
            startCrewOneClick({ id: "proj-a", title: "雨夜", premise: "x" }, { createRun: createRun as any }),
        ).rejects.toMatchObject({ code: "CREW_ASSIST_OFF" });
        expect(createRun).not.toHaveBeenCalled();
    });

    test("剧组协助开 → createAgentRun(L2) 且不 auto-approve", async () => {
        setCrewAssistMode(true, "proj-a");
        const createRun = mock(async (body: { goal: string; level?: string; opts?: Record<string, unknown> }) => {
            expect(body.level).toBe("L2");
            expect(body.goal).toContain("短剧");
            expect(body.opts?.auto_approve).toBe(false);
            expect(body.opts?.source).toBe("crew_one_click");
            expect(body.opts?.source_project_id).toBe("proj-a");
            expect(body.opts?.human_gates).toEqual(["plan", "assembly", "makeup"]);
            return { level: "L2" as const, run_id: "run-1", ack: "已接单" };
        });
        const r = await startCrewOneClick(
            { id: "proj-a", title: "雨夜", premise: "便利店" },
            { createRun: createRun as any },
        );
        expect(r.runId).toBe("run-1");
        expect(r.autoApproved).toBe(false);
        expect(r.level).toBe("L2");
        expect(createRun).toHaveBeenCalledTimes(1);
    });

    test("L0 拒绝建 run", async () => {
        setCrewAssistMode(true, "proj-a");
        const createRun = mock(async () => ({
            level: "L0" as const,
            run_id: null,
            ack: "单步请走对话",
        }));
        await expect(
            startCrewOneClick({ id: "proj-a", title: "x", premise: "y" }, { createRun: createRun as any }),
        ).rejects.toBeInstanceOf(CrewOneClickGateError);
    });

    test("专家文案钉人闸", () => {
        expect(CREW_ONE_CLICK_LABEL).toBe("一键成片");
        expect(CREW_ONE_CLICK_EXPERT_HINT).toContain("人闸");
        expect(CREW_ONE_CLICK_EXPERT_HINT).toContain("不会自动越过");
        expect(CREW_ONE_CLICK_TITLE).toContain("专家");
        expect(CREW_ONE_CLICK_TITLE).toContain("人闸");
    });
});

describe("F2 drama-workspace 一键成片接线", () => {
    const page = read("src/pages/toiv/drama-workspace.tsx");
    const service = read("src/services/toiv/crew-one-click.ts");

    test("仅剧组协助 ON 时露一键面板，走 startCrewOneClick", () => {
        expect(page).toContain('data-testid="crew-one-click-panel"');
        expect(page).toContain('data-testid="crew-one-click-btn"');
        expect(page).toContain("CREW_ONE_CLICK_EXPERT_HINT");
        expect(page).toContain("startCrewOneClick");
        expect(page).toContain("crewOneClickRunPath");
        // 面板嵌在 crewAssist && 分支内
        const idxAssist = page.indexOf("{crewAssist && (");
        const idxPanel = page.indexOf('data-testid="crew-one-click-panel"');
        expect(idxAssist).toBeGreaterThan(-1);
        expect(idxPanel).toBeGreaterThan(idxAssist);
    });

    test("不自动 resume/approve（人闸强制）", () => {
        expect(page).not.toMatch(/resumeAgentRun\s*\(/);
        expect(service).not.toMatch(/resumeAgentRun\s*\(/);
        expect(service).toContain("auto_approve: false");
        expect(service).toContain("agent_team_graph");
        expect(service).toContain("createAgentRun");
        expect(service).toMatch(/import \{ createAgentRun, type AgentRunCreateResult \}/);
        expect(service).not.toMatch(/import \{[^}]*resumeAgentRun/);
    });
});
