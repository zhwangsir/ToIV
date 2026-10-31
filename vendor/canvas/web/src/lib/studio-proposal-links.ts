import type { AssistantStudioProposal, StudioNextAction } from "@/services/api/agent-assistant";
import { parseStudioStage, stageNavSection } from "@/lib/studio-stage-progress";

export function studioProposalActionHref(proposal: AssistantStudioProposal, action: StudioNextAction): string | null {
    if (action.requiresHuman !== true || !proposal.projectId.trim()) return null;
    const params = new URLSearchParams({ project: proposal.projectId });
    if (action.kind === "stage_review") {
        const stage = parseStudioStage(action.stage ?? null);
        if (!stage) return null;
        params.set("section", stageNavSection(stage));
        params.set("stage", stage);
    } else if (action.kind === "render_estimate") {
        params.set("section", "shots");
        if (action.shotId?.trim()) params.set("shot", action.shotId);
        params.set("panel", "estimate");
    } else if (action.kind === "take_compare") {
        if (!action.shotId?.trim()) return null;
        params.set("section", "shots");
        params.set("shot", action.shotId);
        params.set("panel", "compare");
    }
    return `/create?${params.toString()}`;
}
