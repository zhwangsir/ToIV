import Button from "../../components/ui/Button";
import { useTaskCenter, useTaskPolling } from "./TaskCenterProvider";

export type PrimeFace = "pipeline" | "canvas" | "edit";

const FACES: { key: PrimeFace; label: string }[] = [
    { key: "pipeline", label: "流水线" },
    { key: "canvas", label: "画布" },
    { key: "edit", label: "剪辑湾" },
];

export function ToivWorkbar({ face, onFaceChange, onOpenTasks }: {
    face: PrimeFace;
    onFaceChange: (face: PrimeFace) => void;
    onOpenTasks: () => void;
}) {
    useTaskPolling();
    const state = useTaskCenter();
    const running = state.merged.filter(task => task.status === "run").length;
    return (
        <div className="toiv-workbar" role="toolbar" aria-label="ToIV 工作面">
            <span className="toiv-workbar-faces" role="group" aria-label="工作面">
                {FACES.map((item) => (
                    <Button key={item.key} variant={item.key === face ? "lime" : "ghost"}
                        aria-pressed={item.key === face} onClick={() => onFaceChange(item.key)}>
                        {item.label}
                    </Button>
                ))}
            </span>
            <Button size="sm" variant="outline" className="toiv-task-capsule" onClick={onOpenTasks} aria-label="打开任务中心">
                {running > 0 ? <span className="dot run" /> : null}{running > 0 ? `${running} 运行中` : "任务中心"}
            </Button>
        </div>
    );
}
