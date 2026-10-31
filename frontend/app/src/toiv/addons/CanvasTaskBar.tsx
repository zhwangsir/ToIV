import { Link } from "react-router-dom";
import Button from "../../components/ui/Button";
import { primeStatusLabel, usePrimeTasks } from "./TaskDrawerPrime";

export function CanvasTaskBar() {
    const state = usePrimeTasks(true, true);
    const running = state.tasks.filter((task) => task.status === "run");
    const lead = running[0] ?? state.tasks[0];

    return (
        <section className="toiv-taskbar" role="region" aria-label="任务条">
            <div className="toiv-taskbar-stat">
                {state.phase === "loading" && state.tasks.length === 0 ? <span role="status">任务加载中…</span> : null}
                {state.phase === "error" && state.tasks.length === 0 ? <span role="alert">任务载入失败</span> : null}
                {state.phase === "ready" && state.tasks.length === 0 ? <span>队列空闲</span> : null}
                {running.length > 0 ? <span className="run">{running.length} 运行中</span> : null}
                {running.length === 0 && state.tasks.length > 0 ? <span>{state.tasks.length} 项作业 · 无运行中</span> : null}
            </div>
            {lead ? (
                <div className="toiv-taskbar-job">
                    <span className="title">{lead.title}</span>
                    <span className="meta">{primeStatusLabel[lead.status]}</span>
                    {lead.status === "run" && typeof lead.progress === "number" ? (
                        <span className="bar" role="progressbar" aria-label={`${lead.title}进度`}
                            aria-valuemin={0} aria-valuemax={100} aria-valuenow={lead.progress}>
                            <i style={{ width: `${lead.progress}%` }} />
                        </span>
                    ) : null}
                </div>
            ) : null}
            {state.phase === "error" ? <Button size="sm" variant="text" onClick={state.refresh}>重试</Button> : null}
            {state.notice ? <span role="status">{state.notice}</span> : null}
            <Link className="toiv-taskbar-all" to="/history">全部任务</Link>
        </section>
    );
}
