export type StudioStatus = "done" | "run" | "wait";

export const STATUS_LABEL: Record<StudioStatus, string> = { done: "完成", run: "渲染中", wait: "队列" };

export function StatusDot({ status }: { status: StudioStatus }) {
    return (
        <span className={`stv-status-${status}`} aria-label={STATUS_LABEL[status]}>
            <i />
        </span>
    );
}
