import { useEffect, useState, type ReactNode } from "react";
import type { StudioFace } from "../flags";
import { cancelStudioTask, loadStudioTasks, type StudioTaskItem } from "../tasks-model";
import { CompanionBubble } from "../ui/CompanionBubble";
import { FaceSwitcher } from "../ui/FaceSwitcher";
import { TaskDrawer } from "../ui/TaskDrawer";
import { ToastHost } from "../ui/ToastHost";

export type StudioShellProps = {
    face: StudioFace;
    projectLabel: string;
    runningCount: number;
    onFaceChange: (face: StudioFace) => void;
    buddyText?: string;
    onDismissBuddy?: () => void;
    actions?: ReactNode;
    children: ReactNode;
};

export function StudioShell({ face, projectLabel, runningCount, onFaceChange, buddyText, onDismissBuddy, actions, children }: StudioShellProps) {
    const [tasksOpen, setTasksOpen] = useState(false);
    const [tasks, setTasks] = useState<StudioTaskItem[]>([]);
    const refresh = () => { loadStudioTasks().then(setTasks).catch(() => setTasks([])); };
    useEffect(() => {
        if (!tasksOpen) return;
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => clearInterval(timer);
    }, [tasksOpen]);
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
                        <button type="button" className="stv-chip" onClick={() => setTasksOpen(true)} aria-label="打开任务中心">
                            <span className={`stv-chip-dot${runningCount > 0 ? " run" : ""}`} />{runningCount} 运行中
                        </button>
                        {actions}
                    </span>
                </header>
                {children}
            </div>
            <TaskDrawer open={tasksOpen} onClose={() => setTasksOpen(false)} tasks={tasks}
                onCancel={(id) => {
                    const item = tasks.find((task) => task.id === id);
                    if (!item) return;
                    void cancelStudioTask(item).then(() => refresh());
                }} />
            {buddyText && onDismissBuddy ? <CompanionBubble text={buddyText} onDismiss={onDismissBuddy} /> : null}
            <ToastHost />
        </>
    );
}
