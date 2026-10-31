import { useEffect, useRef, useState } from "react";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { loadPrimeJobs, primeJobHeaders, primeJobStatus, type PrimeWorkCard } from "../adapters/works";

export type PrimeTaskItem = {
    id: string;
    title: string;
    status: PrimeWorkCard["status"];
    progress?: number;
    cancellable: boolean;
};

export const primeStatusLabel: Record<PrimeTaskItem["status"], string> = {
    run: "生成中", done: "完成", fail: "失败", wait: "排队 / 等待资源", canceled: "已取消",
};

export async function loadPrimeTasks(signal?: AbortSignal): Promise<PrimeTaskItem[]> {
    const list = await loadPrimeJobs(50, signal);
    return list.map(job => ({
        id: job.id,
        title: job.kind || job.id,
        status: primeJobStatus(job.status ?? ""),
        progress: typeof job.progress?.pct === "number" && Number.isFinite(job.progress.pct)
            ? Math.max(0, Math.min(100, job.progress.pct)) : undefined,
        cancellable: ["running", "queued", "held"].includes(job.status ?? ""),
    }));
}

export async function cancelPrimeTask(id: string, signal?: AbortSignal): Promise<void> {
    if (!id.trim()) throw new Error("Missing job id");
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: primeJobHeaders(), signal });
    if (!res.ok) throw new Error(`cancel ${res.status}`);
    const body = await res.json();
    if (body.ok !== true || body.status !== "canceled") throw new Error("Invalid cancellation response");
}

/** Shared by the history task column and drawer; one read at a time per mounted view. */
export function usePrimeTasks(enabled = true, poll = false) {
    const [tasks, setTasks] = useState<PrimeTaskItem[]>([]);
    const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
    const [pending, setPending] = useState<string | null>(null);
    const [cancelError, setCancelError] = useState<string | null>(null);
    const [notice, setNotice] = useState("");
    const [revision, setRevision] = useState(0);
    const actions = useRef<{ refresh: () => void; cancel: (id: string) => void } | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        let reading: Promise<void> | null = null;
        let cancelling = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        setTasks([]);
        setPending(null);
        setCancelError(null);
        setNotice("");
        setPhase("loading");

        function schedule() {
            clearTimeout(timer);
            if (alive && poll && !cancelling) timer = setTimeout(() => { void refresh(); }, 5000);
        }
        function refresh(): Promise<void> {
            if (!alive) return Promise.resolve();
            if (reading) return reading;
            clearTimeout(timer);
            setPhase("loading");
            reading = loadPrimeTasks(controller.signal).then(next => {
                if (alive) { setTasks(next); setPhase("ready"); }
            }).catch(() => {
                if (alive) setPhase("error");
            }).finally(() => { reading = null; schedule(); });
            return reading;
        }
        async function cancel(id: string) {
            if (!alive || cancelling) return;
            cancelling = true;
            clearTimeout(timer);
            setPending(id);
            setCancelError(null);
            setNotice("");
            try {
                await cancelPrimeTask(id, controller.signal);
                if (!alive) return;
                // Drain any pre-cancel poll before requesting a fresh snapshot.
                await reading;
                if (!alive) return;
                setTasks(current => current.map(task => task.id === id ? { ...task, status: "canceled", cancellable: false } : task));
                setNotice("任务已取消");
                setRevision(value => value + 1);
                await refresh();
            } catch {
                if (alive) setCancelError(id);
            } finally {
                cancelling = false;
                if (alive) setPending(null);
                schedule();
            }
        }
        actions.current = { refresh: () => { void refresh(); }, cancel: id => { void cancel(id); } };
        void refresh();
        return () => {
            alive = false;
            actions.current = null;
            clearTimeout(timer);
            controller.abort();
        };
    }, [enabled, poll]);

    return { tasks, phase, pending, cancelError, notice, revision,
        refresh: () => actions.current?.refresh(), cancel: (id: string) => actions.current?.cancel(id) };
}

export function PrimeTaskList({ state }: { state: ReturnType<typeof usePrimeTasks> }) {
    return <>
        <p className="meta">仅显示 jobs 作业（最近 50 项）</p>
        {state.phase === "loading" ? <p className="meta" role="status">正在载入任务…</p> : null}
        {state.phase === "error" ? <div role="alert">
            <p>任务载入失败</p>
            {state.tasks.length > 0 ? <p className="meta">以下为上次结果，状态可能已变化。</p> : null}
            <Button size="sm" variant="outline" onClick={state.refresh}>重试载入任务</Button>
        </div> : null}
        {state.notice ? <p role="status">{state.notice}</p> : null}
        {state.tasks.map(task => <div className="toiv-task" key={task.id}>
            <div className="row">
                <span className={task.status === "wait" || task.status === "canceled" ? "st" : `st st-${task.status}`} aria-hidden="true" />
                <span className="title">{task.title}</span>
                <span className="meta">{primeStatusLabel[task.status]}</span>
                {task.cancellable ? <Button size="sm" variant="text" className="cancel"
                    disabled={state.pending !== null} onClick={() => state.cancel(task.id)}>
                    {state.pending === task.id ? "取消中…" : state.cancelError === task.id ? "重试取消" : "取消"}
                </Button> : null}
            </div>
            {state.cancelError === task.id ? <p role="alert">取消失败，任务状态未确认，请重试。</p> : null}
            {typeof task.progress === "number" && task.status === "run" ? <div className="bar" role="progressbar"
                aria-label={`${task.title}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}>
                <i style={{ width: `${task.progress}%` }} />
            </div> : null}
        </div>)}
        {state.phase === "ready" && state.tasks.length === 0 ? <p className="meta">队列空闲（jobs 暂无作业）。</p> : null}
    </>;
}

export function TaskDrawerPrime({ open, onClose }: { open: boolean; onClose: () => void }) {
    const state = usePrimeTasks(open, true);
    return <Modal open={open} onClose={onClose} title="任务中心" variant="drawer">
        <PrimeTaskList state={state} />
    </Modal>;
}
