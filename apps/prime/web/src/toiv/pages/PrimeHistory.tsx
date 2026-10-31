import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../../components/ui/Button";
import { PrimeTaskList, primeStatusLabel, usePrimeTasks } from "../addons/TaskDrawerPrime";
import { loadPrimeWorks, type PrimeWorkCard } from "../adapters/works";
import { toivMediaUrl } from "../adapters/media";
import { ToivWorkbar } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

function WorkMedia({ work }: { work: PrimeWorkCard }) {
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const src = work.media ? toivMediaUrl(work.media) : "";
    if (!src || !work.mediaKind) return <div className="thumb">
        {work.status === "fail" ? "生成失败，无可预览媒体" : work.status === "canceled" ? "已取消，无可预览媒体"
            : work.status === "run" || work.status === "wait" ? "等待媒体产出" : "无可预览媒体（暂无产物或格式不支持）"}
    </div>;
    const label = `${work.title} · ${work.mediaKind === "video" ? "视频" : work.mediaKind === "audio" ? "音频" : "图片"}预览`;
    return <>
        {work.mediaKind === "video" ? <video key={attempt} className="thumb" src={src} aria-label={label}
            controls preload="metadata" onError={() => setFailed(true)} />
            : work.mediaKind === "audio" ? <audio key={attempt} className="thumb" src={src} aria-label={label}
                controls preload="metadata" onError={() => setFailed(true)} />
                : <img key={attempt} className="thumb" src={src} alt={label} loading="lazy"
                    referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
        {failed ? <div role="alert"><p>媒体载入失败，文件可能不可用或登录已过期。</p>
            <Button size="sm" variant="outline" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重试媒体</Button>
        </div> : null}
    </>;
}

export default function PrimeHistory() {
    const navigate = useNavigate();
    const [works, setWorks] = useState<PrimeWorkCard[]>([]);
    const tasks = usePrimeTasks();
    const taskColumn = useRef<HTMLDivElement>(null);
    const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        setPhase("loading");
        loadPrimeWorks(controller.signal).then(next => {
            if (alive) { setWorks(next); setPhase("ready"); }
        }).catch(() => { if (alive) setPhase("error"); });
        return () => { alive = false; controller.abort(); };
    }, [attempt, tasks.revision]);
    return (
        <ToivShell>
            <ToivWorkbar face="edit" runningCount={tasks.tasks.filter(task => task.status === "run").length}
                onFaceChange={face => navigate(face === "edit" ? "/history" : face === "canvas" ? "/drama" : "/studio")}
                onOpenTasks={() => taskColumn.current?.scrollIntoView({ behavior: "smooth" })} />
            <section className="toiv-history">
                <div className="toiv-assets-col">
                    <h3>作品 {phase === "ready" || works.length > 0 ? <span className="meta">{works.length}</span> : null}</h3>
                    <p className="meta">jobs 产物 · 最近 100 项作业</p>
                    {phase === "loading" ? <div className="toiv-empty" role="status"><p>正在载入作品…</p></div> : null}
                    {phase === "error" ? <div className="toiv-empty" role="alert"><p>作品库载入失败</p>
                        {works.length > 0 ? <p>以下为上次结果，状态可能已变化。</p> : null}
                        <Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>重试载入作品</Button>
                    </div> : null}
                    {phase === "ready" && works.length === 0 ? <div className="toiv-empty"><p>还没有产物。去流水线生成第一个镜头。</p></div> : null}
                    <div className="toiv-grid">
                        {works.map(work => (
                            <article className="toiv-card" key={work.id}>
                                <WorkMedia key={work.media ?? work.id} work={work} />
                                <header><b>{work.title}</b><span className={work.status === "canceled" ? "meta"
                                    : work.status === "fail" ? "flag flag-fail" : work.status === "run" ? "flag flag-run" : "flag"}>
                                    {primeStatusLabel[work.status]}
                                </span></header>
                                <div className="meta">{work.kind} · {work.createdAt}</div>
                            </article>
                        ))}
                    </div>
                </div>
                <div className="toiv-assets-col" ref={taskColumn}>
                    <h3>任务 {tasks.phase === "ready" || tasks.tasks.length > 0 ? <span className="meta">{tasks.tasks.length}</span> : null}</h3>
                    <PrimeTaskList state={tasks} />
                </div>
            </section>
        </ToivShell>
    );
}
