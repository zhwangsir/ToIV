import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Center-stage script parse surface — content first (editor + status).
 * Form controls (shot count, SVML, actions) belong in Inspector via slots.
 */
export function CreationStudioScriptStage({
    editor,
    status,
    result,
    className,
}: {
    editor: ReactNode;
    status?: ReactNode;
    result?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("toiv-script-stage", className)} data-testid="creation-studio-script-stage">
            <header className="toiv-script-stage-head">
                <h2 className="toiv-script-stage-title">剧本解析</h2>
                <p className="toiv-script-stage-meta">中舞台只放正文与结果 · 参数在右侧 Inspector</p>
            </header>
            <div className="toiv-script-stage-editor">{editor}</div>
            {status ? <div className="toiv-script-stage-status">{status}</div> : null}
            {result ? <div className="toiv-script-stage-result" data-testid="creation-studio-script-result">{result}</div> : null}
        </div>
    );
}
