import Button from "../../components/ui/Button";

export type PrimeFace = "pipeline" | "canvas" | "edit";

const FACES: { key: PrimeFace; label: string }[] = [
    { key: "pipeline", label: "流水线" },
    { key: "canvas", label: "画布" },
    { key: "edit", label: "剪辑湾" },
];

export function ToivWorkbar({ face, runningCount, onFaceChange, onOpenTasks }: {
    face: PrimeFace;
    runningCount?: number;
    onFaceChange: (face: PrimeFace) => void;
    onOpenTasks: () => void;
}) {
    const running = (runningCount ?? 0) > 0;
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
                {running ? <span className="dot run" /> : null}{running ? `${runningCount} 运行中` : "任务中心"}
            </Button>
        </div>
    );
}
