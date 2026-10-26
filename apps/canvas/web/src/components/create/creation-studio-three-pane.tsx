import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import "@/components/create/creation-studio-three-pane.css";

type CreationStudioThreePaneProps = {
    rail: ReactNode;
    stage: ReactNode;
    inspector: ReactNode;
    className?: string;
};

/** Single creation-studio shell: asset rail | stage | inspector. No second product shell. */
export function CreationStudioThreePane({ rail, stage, inspector, className }: CreationStudioThreePaneProps) {
    return (
        <div className={cn("toiv-create-studio", className)} data-testid="creation-studio-three-pane">
            <aside className="toiv-create-rail" aria-label="资产栏" data-testid="creation-studio-rail">
                {rail}
            </aside>
            <div className="toiv-create-stage" data-testid="creation-studio-stage">
                {stage}
            </div>
            <aside className="toiv-create-inspector" aria-label="属性 Inspector" data-testid="creation-studio-inspector">
                {inspector}
            </aside>
        </div>
    );
}
