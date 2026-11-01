import { useState } from "react";
import { Link } from "react-router-dom";
import Button from "../../components/ui/Button";
import { primeDiagnostics, primeDuration, primeRelativeTime, primeStatusLabel, type PrimeTask } from "../adapters/tasks";
import { useTaskCenter, useTaskPolling, type TaskCenterValue } from "../addons/TaskCenterProvider";
import ToivShell from "../shell/ToivShell";

const FILTERS = [
    { key: "all", label: "全部" },
    { key: "active", label: "进行中" },
    { key: "failed", label: "失败" },
    { key: "finished", label: "已结束" },
] as const;
type FilterKey = typeof FILTERS[number]["key"];

const HEALTH_LABEL = { reachable: "引擎正常", degraded: "部分引擎降级", unreachable: "引擎不可达" } as const;
const DEP_STATE_LABEL = { reachable: "可用", degraded: "降级", unreachable: "不可达" } as const;
const POST_LABEL: Record<string, string> = { processing: "后处理中", trim: "精确裁切中", extend: "延展中" };

function matches(task: PrimeTask, filter: FilterKey): boolean {
    if (filter === "all") return true;
    if (filter === "active") return task.status === "run" || task.status === "wait";
    if (filter === "failed") return task.status === "fail";
    return task.status === "done" || task.status === "canceled";
}

function stepText(task: PrimeTask): string {
    if (task.step !== undefined && task.total !== undefined && task.total > 0) return `第 ${task.step}/${task.total} 步`;
    if (typeof task.progress === "number") return `${Math.round(task.progress)}%`;
    return task.phaseLabel || "—";
}

function artifactText(task: PrimeTask): string {
    if (task.results.length > 0) {
        const post = task.postStatus ? ` · ${POST_LABEL[task.postStatus] || task.postStatus}` : "";
        return `${task.results.length} 个产物${post}`;
    }
    if (task.status === "run" || task.status === "wait") return "等待产出";
    return "无产物";
}

function receiptText(task: PrimeTask): string {
    if (task.holdReason) return task.holdReason;
    if (task.failure) return task.failure.label;
    if (task.runtime?.state === "stalled") return task.runtime.label || "长时间无进展";
    if (task.runtime?.state === "waiting") return task.runtime.label || "等待资源";
    return primeStatusLabel[task.status];
}

function waitText(task: PrimeTask): string {
    const parts: string[] = [];
    if (task.queuePos !== undefined) parts.push(`队列第 ${task.queuePos} 位`);
    if (task.waitSec !== undefined) parts.push(`已等待 ${primeDuration(task.waitSec)}`);
    if (task.etaSec !== undefined && task.etaSec !== null) parts.push(`预计 ${primeDuration(task.etaSec)}`);
    return parts.join(" · ");
}

function Summary({ state }: { state: TaskCenterValue }) {
    const known = state.recentPhase === "ready" || state.merged.length > 0;
    const count = (predicate: (task: PrimeTask) => boolean) => known ? state.merged.filter(predicate).length : "—";
    return <div className="toiv-tasks-summary" aria-label="任务统计">
        <div className="toiv-summary"><span className="n">{count(task => task.status === "run")}</span><span className="label">进行中</span></div>
        <div className="toiv-summary"><span className="n">{count(task => task.status === "wait")}</span><span className="label">排队 / 等待</span></div>
        <div className="toiv-summary"><span className="n">{count(task => task.status === "fail")}</span><span className="label">失败</span></div>
        <div className="toiv-summary"><span className="n">{count(task => task.status === "done")}</span><span className="label">完成</span></div>
        <div className="toiv-summary muted">
            <span className="n">{state.counts ? state.counts.total : "—"}</span><span className="label">累计作品</span>
        </div>
    </div>;
}

function Health({ state }: { state: TaskCenterValue }) {
    return <section className="toiv-health" aria-label="引擎状态">
        <b>引擎</b>
        {state.healthPhase === "idle" || state.healthPhase === "loading"
            ? <span className="meta" role="status">正在检查引擎…</span> : null}
        {state.healthPhase === "error" ? <>
            <span className="toiv-health-bad" role="alert">引擎状态载入失败</span>
            <Button size="sm" variant="text" onClick={state.refreshHealth}>重试引擎检查</Button>
        </> : null}
        {state.healthPhase === "ready" && state.health ? <>
            <span className={`toiv-health-pill ${state.health.overall}`}>{HEALTH_LABEL[state.health.overall]}</span>
            {state.health.deps.length > 0 ? <span className="toiv-health-deps">
                {state.health.deps.map(dep => <span key={dep.id} className={`toiv-dep ${dep.state}`} title={dep.blockHint || dep.summary}>
                    {dep.label} · {DEP_STATE_LABEL[dep.state]}
                </span>)}
            </span> : null}
            {state.health.overall === "unreachable" ? <span className="meta">渲染任务会排队或失败，先恢复引擎再提交。</span> : null}
        </> : null}
        <Button size="sm" variant="ghost" className="toiv-health-refresh" onClick={state.refreshHealth}>刷新引擎</Button>
    </section>;
}

function TaskCard({ task, state }: { task: PrimeTask; state: TaskCenterValue }) {
    const [diagnostics, setDiagnostics] = useState("");
    const [copied, setCopied] = useState("");
    const pending = state.pending === task.id;
    const failedCancel = state.cancelError === task.id;
    const waits = waitText(task);
    const copy = async () => {
        const text = primeDiagnostics(task);
        setDiagnostics(text);
        try {
            await navigator.clipboard.writeText(text);
            setCopied("诊断信息已复制");
        } catch {
            setCopied("剪贴板不可用，已展开诊断信息供手动复制");
        }
    };
    return <article className={`toiv-task-card ${task.status}`}>
        <header>
            <div className="toiv-task-card-title">
                <b>{task.title}</b>
                <span className="meta">{task.kind || task.id} · {primeRelativeTime(task.createdAt)}</span>
            </div>
            <span className={`toiv-task-status ${task.status}`}>{primeStatusLabel[task.status]}</span>
        </header>
        <div className="toiv-axes">
            <div><span className="label">步骤</span><span>{stepText(task)}</span></div>
            <div><span className="label">产物</span><span>{artifactText(task)}</span></div>
            <div><span className="label">回执</span><span>{receiptText(task)}</span></div>
        </div>
        {typeof task.progress === "number" && task.status === "run" ? <div className="bar" role="progressbar"
            aria-label={`${task.title}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}>
            <i style={{ width: `${task.progress}%` }} /></div> : null}
        {waits ? <p className="meta">{waits}</p> : null}
        {task.phaseLabel && task.phaseLabel !== receiptText(task) ? <p className="meta">{task.phaseLabel}</p> : null}
        {task.runtime?.state === "stalled" && task.runtime.reason ? <p className="meta">停滞后端报告：{task.runtime.reason}</p> : null}
        {task.failure ? <div className="toiv-task-failure">
            <p><b>{task.failure.label}</b> · {task.failure.hint}</p>
            {task.error ? <details><summary>原始错误</summary><pre>{task.error}</pre></details> : null}
        </div> : null}
        {failedCancel ? <p role="alert">取消失败，任务状态未确认，请重试。</p> : null}
        <footer className="toiv-task-actions">
            {task.cancellable ? <Button size="sm" variant="outline" disabled={state.pending !== null} onClick={() => state.cancel(task.id)}>
                {pending ? "取消中…" : failedCancel ? "重试取消" : "取消"}
            </Button> : null}
            {task.canRerun ? <Button size="sm" variant="lime" disabled={state.rerunning !== null} onClick={() => state.rerun(task.id)}>
                {state.rerunning === task.id ? "提交中…" : "重试"}
            </Button> : null}
            <Button size="sm" variant="ghost" onClick={() => { void copy(); }}>复制诊断</Button>
            {task.results.length > 0 ? <Link className="toiv-task-link" to="/library">作品库</Link> : null}
            {task.projectId ? <Link className="toiv-task-link" to={`/studio/${task.projectId}`}>打开项目</Link> : null}
        </footer>
        {copied ? <p role="status" className="meta">{copied}</p> : null}
        {diagnostics ? <pre className="toiv-diagnostics" aria-label={`${task.title}诊断信息`}>{diagnostics}</pre> : null}
    </article>;
}

export default function PrimeTasks() {
    useTaskPolling();
    const state = useTaskCenter();
    const [filter, setFilter] = useState<FilterKey>("all");
    const tasks = state.merged.filter(task => matches(task, filter));
    const empty = state.recentPhase === "ready" && state.merged.length === 0;
    return (
        <ToivShell>
            <section className="toiv-tasks">
                <header className="toiv-tasks-head">
                    <div>
                        <h1>任务中心</h1>
                        <p className="meta">进行中的生成、排队原因与失败回执都在这里；任务条与各页面共用同一份数据。</p>
                    </div>
                    <div className="toiv-tasks-head-actions">
                        <Button size="sm" variant="outline" to="/library">作品库</Button>
                        <Button size="sm" variant="ghost" onClick={() => { state.refresh(); state.refreshHealth(); }}>刷新</Button>
                    </div>
                </header>
                <Summary state={state} />
                <Health state={state} />
                <div className="toiv-task-filters" role="group" aria-label="任务筛选">
                    {FILTERS.map(item => <Button key={item.key} size="sm" variant={filter === item.key ? "dark" : "ghost"}
                        aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}</Button>)}
                </div>
                {state.recentPhase === "error" ? <div className="toiv-tasks-error" role="alert">
                    <p>任务载入失败</p>
                    {state.merged.length > 0 ? <p className="meta">以下为上次结果，状态可能已变化。</p> : null}
                    <Button size="sm" variant="outline" onClick={state.refresh}>重试载入任务</Button>
                </div> : null}
                {state.notice ? <p role="status" className={state.noticeError ? "toiv-notice error" : "toiv-notice"}>{state.notice}</p> : null}
                {state.recentPhase === "idle" || (state.recentPhase === "loading" && state.merged.length === 0)
                    ? <p className="toiv-empty" role="status">正在载入任务…</p> : null}
                {empty ? <div className="toiv-empty">
                    <p>队列空闲。这里会列出你的生成任务与失败回执。</p>
                    <Button variant="lime" size="sm" to="/studio/new">去创作</Button>
                </div> : null}
                {!empty && tasks.length === 0 && state.merged.length > 0 ? <div className="toiv-empty">
                    <p>没有符合筛选的任务。</p>
                    <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>清除筛选</Button>
                </div> : null}
                <div className="toiv-task-grid">
                    {tasks.map(task => <TaskCard key={task.id} task={task} state={state} />)}
                </div>
            </section>
        </ToivShell>
    );
}
