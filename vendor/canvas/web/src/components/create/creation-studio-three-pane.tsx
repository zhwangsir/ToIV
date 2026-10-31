import type { ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { cn } from "@/lib/utils";

import "@/components/create/creation-studio-three-pane.css";

type CreationStudioThreePaneProps = {
    rail: ReactNode;
    stage: ReactNode;
    inspector: ReactNode;
    className?: string;
    /** When set, right inspector expands to --toiv-shot-detail-w (420). */
    shotSelected?: boolean;
    inspectorVisible?: boolean;
    onToggleInspector?: () => void;
};

/** Single creation-studio shell: asset rail | stage | inspector.
 * B2: BeefTV dense surface hierarchy; no second product / colorful shell.
 */
export function CreationStudioThreePane({ rail, stage, inspector, className, shotSelected = false, inspectorVisible = true, onToggleInspector }: CreationStudioThreePaneProps) {
    return (
        <div
            className={cn("toiv-create-studio", shotSelected && "is-shot-selected", !inspectorVisible && "is-inspector-hidden", className)}
            data-testid="creation-studio-three-pane"
            data-shot-selected={shotSelected ? "1" : "0"}
            data-inspector-visible={inspectorVisible ? "1" : "0"}
        >
            <aside className="toiv-create-rail" aria-label="资产栏" data-testid="creation-studio-rail">
                {rail}
            </aside>
            <div className="toiv-create-splitter" aria-hidden data-testid="creation-studio-splitter-left" />
            <div className="toiv-create-stage" data-testid="creation-studio-stage">
                {stage}
            </div>
            {inspectorVisible ? (
                <>
                    <div className="toiv-create-splitter" aria-hidden data-testid="creation-studio-splitter-right" />
                    <aside className="toiv-create-inspector" aria-label="属性" data-testid="creation-studio-inspector">
                        {inspector}
                    </aside>
                </>
            ) : null}
            {onToggleInspector ? (
                <button type="button" className="toiv-create-inspector-toggle" aria-label={inspectorVisible ? "收起属性" : "打开属性"} title={inspectorVisible ? "收起属性" : "打开属性"} onClick={onToggleInspector}>
                    {inspectorVisible ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
                </button>
            ) : null}
        </div>
    );
}
