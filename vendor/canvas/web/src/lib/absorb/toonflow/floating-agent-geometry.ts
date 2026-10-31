/**
 * Adapted from HBAI-Ltd/Toonflow-app@30139c931e80476caa718b31684b86383c6e83ce
 * apps/web/src/pages/workspace/components/floatingAgent.vue (MIT)
 * Copyright (c) 2026 HBAI-Ltd — see ../NOTICE
 *
 * Dock ↔ float geometry only (no Vue). Used by canvas assistant chrome.
 */
export type AssistantPresentation = "dock" | "float";

export type FloatingAgentLayoutInput = {
    presentation: AssistantPresentation;
    viewportWidth: number;
    viewportHeight: number;
    preferredWidth: number;
    preferredHeight?: number;
    /** Distance from right edge when floating. */
    rightGap?: number;
    /** Distance from bottom edge when floating. */
    bottomGap?: number;
};

export type FloatingAgentLayout = {
    left: number;
    top: number;
    width: number;
    height: number;
    maxWidth: number;
    gap: number;
};

export function computeFloatingAgentLayout(input: FloatingAgentLayoutInput): FloatingAgentLayout {
    const gap = Math.min(15, input.viewportWidth / 2, input.viewportHeight / 2);
    const rightGap = input.rightGap ?? gap;
    const bottomGap = input.bottomGap ?? gap;
    const docked = input.presentation === "dock";
    const maxWidth = Math.max(0, docked ? input.viewportWidth * 0.45 : input.viewportWidth - gap * 2);
    const width = Math.min(Math.max(280, input.preferredWidth), maxWidth || input.preferredWidth);
    const height = docked
        ? input.viewportHeight
        : Math.min(input.preferredHeight ?? input.viewportHeight * 0.8, input.viewportHeight - gap * 2);
    const left = docked
        ? Math.max(0, input.viewportWidth - width)
        : Math.max(gap, Math.min(input.viewportWidth - width - rightGap, input.viewportWidth - gap - width));
    const top = docked ? 0 : Math.max(gap, Math.min(input.viewportHeight - height - bottomGap, input.viewportHeight - gap - height));
    return { left, top, width, height, maxWidth, gap };
}
