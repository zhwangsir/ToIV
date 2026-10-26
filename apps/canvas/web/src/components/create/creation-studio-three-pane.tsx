import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import "@/components/create/creation-studio-three-pane.css";

type CreationStudioThreePaneProps = {
    rail: ReactNode;
    stage: ReactNode;
    inspector: ReactNode;
    className?: string;
    /** When set, right inspector expands to --toiv-shot-detail-w (420). */
    shotSelected?: boolean;
};

/** Single creation-studio shell: asset rail | stage | inspector. No second product shell. */
export function CreationStudioThreePane({ rail, stage, inspector, className, shotSelected = false }: CreationStudioThreePaneProps) {
    return (
        <div
            className={cn("toiv-create-studio", shotSelected && "is-shot-selected", className)}
            data-testid="creation-studio-three-pane"
            data-shot-selected={shotSelected ? "1" : "0"}
        >
            <aside className="toiv-create-rail" aria-label="资产栏" data-testid="creation-studio-rail">
                {rail}
            </aside>
            <div className="toiv-create-splitter" aria-hidden data-testid="creation-studio-splitter-left" />
            <div className="toiv-create-stage" data-testid="creation-studio-stage">
                {stage}
            </div>
            <div className="toiv-create-splitter" aria-hidden data-testid="creation-studio-splitter-right" />
            <aside className="toiv-create-inspector" aria-label="属性 Inspector" data-testid="creation-studio-inspector">
                {inspector}
            </aside>
        </div>
    );
}
