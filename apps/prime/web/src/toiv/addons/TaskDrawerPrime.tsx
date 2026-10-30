import { useEffect, useState } from "react";

export type PrimeTaskItem = {
    id: string;
    title: string;
    status: "run" | "done" | "fail" | "wait";
    progress?: number;
    cancellable: boolean;
};

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function statusOf(raw: string): PrimeTaskItem["status"] {
    if (raw === "running" || raw === "rendering" || raw === "processing") return "run";
    if (raw === "done" || raw === "succeeded" || raw === "success") return "done";
    if (raw === "failed" || raw === "error") return "fail";
    return "wait";
}

export async function loadPrimeTasks(): Promise<PrimeTaskItem[]> {
    const res = await fetch("/api/jobs?limit=50", { headers: authHeaders() });
    if (!res.ok) throw new Error(`jobs ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.jobs ?? []);
    return list.map((job: { id: string; title?: string; kind?: string; status?: string; progress?: number }) => {
        const status = statusOf(job.status ?? "");
        return {
            id: job.id,
            title: job.title ?? job.kind ?? job.id,
            status,
            progress: typeof job.progress === "number" ? job.progress : undefined,
            cancellable: status === "run",
        };
    });
}

export async function cancelPrimeTask(id: string): Promise<void> {
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: authHeaders() });
    if (!res.ok) throw new Error(`cancel ${res.status}`);
}

export function TaskDrawerPrime({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [tasks, setTasks] = useState<PrimeTaskItem[]>([]);
    const refresh = () => { loadPrimeTasks().then(setTasks).catch(() => setTasks([])); };
    useEffect(() => {
        if (!open) return;
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => clearInterval(timer);
    }, [open]);
    return (
        <aside className={`toiv-drawer${open ? " open" : ""}`} aria-label="任务中心" aria-hidden={!open}>
            <header>
                <b>任务中心</b><span className="meta">{tasks.length} 项</span>
                <button type="button" className="toiv-drawer-x" onClick={onClose} aria-label="关闭任务中心">×</button>
            </header>
            {tasks.map((task) => (
                <div className="toiv-task" key={task.id}>
                    <div className="row">
                        <span className={`st st-${task.status}`} />
                        <span className="title">{task.title}</span>
                        {task.cancellable ? (
                            <button type="button" className="cancel" onClick={() => { void cancelPrimeTask(task.id).then(refresh); }}>取消</button>
                        ) : null}
                    </div>
                    {typeof task.progress === "number" ? <div className="bar"><i style={{ width: `${task.progress}%` }} /></div> : null}
                </div>
            ))}
            {tasks.length === 0 ? <div className="toiv-task"><div className="row">队列空闲</div></div> : null}
        </aside>
    );
}
