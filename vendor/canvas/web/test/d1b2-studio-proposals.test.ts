import { describe, expect, test } from "bun:test";

import type { AgentTurnEnd, AssistantStudioProposal, StudioNextAction } from "../src/services/api/agent-assistant";
import { studioProposalActionHref } from "../src/lib/studio-proposal-links";
import { parseStudioStage } from "../src/lib/studio-stage-progress";
import { shotInspectorPanelFromQuery } from "../src/components/toiv/shot-revision-inspector";

const source = {
    projectId: "project-1",
    stageRevision: 7,
    shotId: "shot-1",
    candidatesDigest: "digest-1",
};

const proposal: AssistantStudioProposal = {
    proposalId: "proposal-1",
    kind: "studio_production",
    projectId: "project-1",
    summary: "请确认分镜并比较镜头候选",
    warnings: ["候选尚未拍板"],
    source,
    nextActions: [],
};

function action(partial: Partial<StudioNextAction>): StudioNextAction {
    return {
        kind: "stage_review",
        stage: "storyboard",
        label: "人工复核",
        section: "storyboard",
        requiresHuman: true,
        ...partial,
    } as StudioNextAction;
}

describe("D1b2 Studio 提案契约与深链", () => {
    test("AgentTurnEnd 可携带 studioProposals，旧回合类型仍允许完全省略", () => {
        const withProposal: AgentTurnEnd = {
            type: "turn_end",
            reply: "请人工复核",
            toolCalls: [],
            error: null,
            cancelled: false,
            studioProposals: [proposal],
        };
        const legacy: AgentTurnEnd = {
            type: "turn_end",
            reply: "旧回复",
            toolCalls: [],
            error: null,
            cancelled: false,
        };
        expect(withProposal.studioProposals?.[0].source.stageRevision).toBe(7);
        expect(legacy.studioProposals).toBeUndefined();
    });

    test("stage_review 深链使用阶段对应区段并保留 stage", () => {
        expect(studioProposalActionHref(proposal, action({ stage: "voice", section: "shots" }))).toBe(
            "/create?project=project-1&section=shots&stage=voice",
        );
        expect(studioProposalActionHref(proposal, action({ stage: "timeline", section: "final" }))).toBe(
            "/create?project=project-1&section=timeline&stage=timeline",
        );
    });

    test("render_estimate 深链到 shots 预估，shot 可选", () => {
        expect(studioProposalActionHref(proposal, action({ kind: "render_estimate", stage: undefined, shotId: "shot-1" }))).toBe(
            "/create?project=project-1&section=shots&shot=shot-1&panel=estimate",
        );
        expect(studioProposalActionHref(proposal, action({ kind: "render_estimate", stage: undefined, shotId: undefined }))).toBe(
            "/create?project=project-1&section=shots&panel=estimate",
        );
    });

    test("take_compare 深链必须带 shot", () => {
        expect(studioProposalActionHref(proposal, action({ kind: "take_compare", stage: undefined, shotId: "shot-1", candidateId: "candidate-1" }))).toBe(
            "/create?project=project-1&section=shots&shot=shot-1&panel=compare",
        );
        expect(studioProposalActionHref(proposal, action({ kind: "take_compare", stage: undefined, shotId: undefined }))).toBeNull();
    });

    test("requiresHuman 非 true 的动作不产出链接，非法 stage 被忽略", () => {
        expect(studioProposalActionHref(proposal, action({ requiresHuman: false } as unknown as StudioNextAction))).toBeNull();
        expect(studioProposalActionHref(proposal, action({ stage: "not-a-stage" } as unknown as StudioNextAction))).toBeNull();
        expect(parseStudioStage("generate")).toBe("generate");
        expect(parseStudioStage("not-a-stage")).toBeNull();
        expect(parseStudioStage(null)).toBeNull();
    });

    test("镜头 panel 只接受四种已知值", () => {
        expect(shotInspectorPanelFromQuery("compare")).toBe("compare");
        expect(shotInspectorPanelFromQuery("estimate")).toBe("estimate");
        expect(shotInspectorPanelFromQuery("recipes")).toBe("recipes");
        expect(shotInspectorPanelFromQuery("history")).toBe("history");
        expect(shotInspectorPanelFromQuery("render")).toBeNull();
        expect(shotInspectorPanelFromQuery(null)).toBeNull();
    });
});
