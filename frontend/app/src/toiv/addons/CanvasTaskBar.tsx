import { Link } from "react-router-dom";
import Button from "../../components/ui/Button";
import { primeStatusLabel } from "../adapters/tasks";
import { useTaskCenter, useTaskPolling } from "./TaskCenterProvider";

export function CanvasTaskBar() {
    useTaskPolling();
    const state = useTaskCenter();
    const running = state.merged.filter(task => task.status === "run");
    const lead = running[0] ?? state.merged[0];
    const known = state.recentPhase !== "idle" && state.recentPhase !== "loading";

    return (
        <section className="toiv-taskbar" role="region" aria-label="任务条">
            <div className="toiv-taskbar-stat">
                {!known && state.merged.length === 0 ? <span role="status">任务加载中…</span> : null}
                {state.recentPhase === "error" && state.merged.length === 0 ? <span role="alert">任务载入失败</span> : null}
                {state.recentPhase === "ready" && state.merged.length === 0 ? <span>队列空闲</span> : null}
                {running.length > 0 ? <span className="run">{running.length} 运行中</span> : null}
                {running.length === 0 && known && state.merged.length > 0 ? <span>{state.merged.length} 项作业 · 无运行中</span> : null}
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
            {state.recentPhase === "error" ? <Button size="sm" variant="text" onClick={state.refresh}>重试</Button> : null}
            {state.notice ? <span role="status">{state.notice}</span> : null}
            <Link className="toiv-taskbar-all" to="/tasks">全部任务</Link>
        </section>
    );
}
