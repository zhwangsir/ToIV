import type { StudioTaskItem } from "../tasks-model";

const GROUPS: { key: StudioTaskItem["source"]; label: string }[] = [
    { key: "job", label: "ToIV 作业" },
    { key: "canvas", label: "画布同步" },
    { key: "agent", label: "智能体会话" },
];

export function TaskDrawer({ open, onClose, tasks, onCancel }: {
    open: boolean;
    onClose: () => void;
    tasks: StudioTaskItem[];
    onCancel: (id: string) => void;
}) {
    return (
        <aside className={`stv-drawer${open ? " open" : ""}`} aria-label="任务中心" aria-hidden={!open}>
            <header><b>任务中心</b><span className="meta">{tasks.length} 项</span>
                <button type="button" className="stv-drawer-x" onClick={onClose} aria-label="关闭任务中心">×</button></header>
            {GROUPS.map((group) => {
                const rows = tasks.filter((task) => task.source === group.key);
                if (rows.length === 0) return null;
                return (
                    <section key={group.key}>
                        <h5>{group.label}</h5>
                        {rows.map((task) => (
                            <div className="stv-task" key={task.id}>
                                <div className="row">
                                    <span className={`stv-status-${task.status}`}><i /></span>
                                    <span className="title">{task.title}</span>
                                    {task.cancellable ? <button type="button" className="cancel" onClick={() => onCancel(task.id)}>取消</button> : null}
                                </div>
                                {typeof task.progress === "number" ? <div className="stv-progress"><i style={{ width: `${task.progress}%` }} /></div> : null}
                                {task.sub ? <div className="sub">{task.sub}</div> : null}
                            </div>
                        ))}
                    </section>
                );
            })}
            {tasks.length === 0 ? <div className="stv-task"><div className="row">队列空闲</div><div className="sub">所有作业已完成</div></div> : null}
        </aside>
    );
}
