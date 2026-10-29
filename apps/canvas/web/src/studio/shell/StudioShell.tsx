import type { ReactNode } from "react";
import type { StudioFace } from "../flags";
import { CompanionBubble } from "../ui/CompanionBubble";
import { FaceSwitcher } from "../ui/FaceSwitcher";
import { ToastHost } from "../ui/ToastHost";

export type StudioShellProps = {
    face: StudioFace;
    projectLabel: string;
    runningCount: number;
    onOpenTasks: () => void;
    onFaceChange: (face: StudioFace) => void;
    buddyText?: string;
    onDismissBuddy?: () => void;
    actions?: ReactNode;
    children: ReactNode;
};

export function StudioShell({ face, projectLabel, runningCount, onOpenTasks, onFaceChange, buddyText, onDismissBuddy, actions, children }: StudioShellProps) {
    return (
        <>
            <div className="stv-aurora" aria-hidden="true" />
            <div className="stv-veil" aria-hidden="true" />
            <div className="stv-shell">
                <header className="stv-appbar">
                    <span className="stv-lockup"><span className="stv-mark">TV</span>ToIV</span>
                    <span className="stv-proj">{projectLabel}</span>
                    <FaceSwitcher value={face} onChange={onFaceChange} />
                    <span className="stv-appbar-slot" />
                    <span className="stv-appbar-right">
                        <button type="button" className="stv-chip" onClick={onOpenTasks} aria-label="打开任务中心">
                            <span className={`stv-chip-dot${runningCount > 0 ? " run" : ""}`} />{runningCount} 运行中
                        </button>
                        {actions}
                    </span>
                </header>
                {children}
            </div>
            {buddyText && onDismissBuddy ? <CompanionBubble text={buddyText} onDismiss={onDismissBuddy} /> : null}
            <ToastHost />
        </>
    );
}
