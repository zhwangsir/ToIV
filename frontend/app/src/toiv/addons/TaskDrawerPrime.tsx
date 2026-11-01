import { Link } from "react-router-dom";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { primeStatusLabel, primeRelativeTime, type PrimeTask } from "../adapters/tasks";
import { useTaskCenter, useTaskPolling, type TaskCenterValue } from "./TaskCenterProvider";

const ACTIVE = new Set(["run", "wait"]);

function PrimeTaskRow({ task, state }: { task: PrimeTask; state: TaskCenterValue }) {
    const pending = state.pending === task.id;
    const failed = state.cancelError === task.id;
    return <div className="toiv-task">
        <div className="row">
            <span className={task.status === "wait" || task.status === "canceled" ? "st" : `st st-${task.status}`} aria-hidden="true" />
            <span className="title">{task.title}</span>
            <span className="meta">{primeStatusLabel[task.status]}</span>
            {task.cancellable ? <Button size="sm" variant="text" className="cancel"
                disabled={state.pending !== null} onClick={() => state.cancel(task.id)}>
                {pending ? "取消中…" : failed ? "重试取消" : "取消"}
            </Button> : null}
        </div>
        {failed ? <p role="alert">取消失败，任务状态未确认，请重试。</p> : null}
        {typeof task.progress === "number" && task.status === "run" ? <div className="bar" role="progressbar"
            aria-label={`${task.title}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}>
            <i style={{ width: `${task.progress}%` }} />
        </div> : null}
        {task.holdReason ? <p className="meta">{task.holdReason}</p> : null}
        {task.failure ? <p className="meta">{task.failure.label} · {task.failure.hint}</p> : null}
        {task.status === "done" && task.results.length > 0 ? <p className="meta">
            <Link to="/library">在作品库查看</Link>
        </p> : null}
        {task.scope === "recent" && task.createdAt ? <p className="meta">{primeRelativeTime(task.createdAt)}</p> : null}
    </div>;
}

export function PrimeTaskList({ state, note = true }: { state: TaskCenterValue; note?: boolean }) {
    const tasks = state.merged;
    const busy = state.recentPhase === "idle" || state.recentPhase === "loading";
    const active = tasks.filter(task => ACTIVE.has(task.status));
    const recent = tasks.filter(task => !ACTIVE.has(task.status));
    return <>
        {note ? <p className="meta">仅显示 jobs 作业（最近 50 项）</p> : null}
        {busy && tasks.length === 0 ? <p className="meta" role="status">正在载入任务…</p> : null}
        {state.recentPhase === "error" ? <div role="alert">
            <p>任务载入失败</p>
            {tasks.length > 0 ? <p className="meta">以下为上次结果，状态可能已变化。</p> : null}
            <Button size="sm" variant="outline" onClick={state.refresh}>重试载入任务</Button>
        </div> : null}
        {state.notice ? <p role="status" className={state.noticeError ? "toiv-notice error" : "toiv-notice"}>{state.notice}</p> : null}
        {active.length > 0 ? <p className="toiv-task-group">进行中 <span className="meta">{active.length}</span></p> : null}
        {active.map(task => <PrimeTaskRow key={task.id} task={task} state={state} />)}
        {recent.length > 0 ? <p className="toiv-task-group">最近</p> : null}
        {recent.map(task => <PrimeTaskRow key={task.id} task={task} state={state} />)}
        {state.recentPhase === "ready" && tasks.length === 0 ? <p className="meta">队列空闲（jobs 暂无作业）。</p> : null}
    </>;
}

export function TaskDrawerPrime({ open, onClose }: { open: boolean; onClose: () => void }) {
    useTaskPolling(open);
    const state = useTaskCenter();
    return <Modal open={open} onClose={onClose} title="任务中心" variant="drawer">
        <PrimeTaskList state={state} />
    </Modal>;
}
