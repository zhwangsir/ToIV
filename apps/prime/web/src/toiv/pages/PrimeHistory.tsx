import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cancelPrimeTask, loadPrimeTasks, type PrimeTaskItem } from "../addons/TaskDrawerPrime";
import { loadPrimeWorks, type PrimeWorkCard } from "../adapters/works";
import { ToivWorkbar } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

export default function PrimeHistory() {
    const navigate = useNavigate();
    const [works, setWorks] = useState<PrimeWorkCard[]>([]);
    const [tasks, setTasks] = useState<PrimeTaskItem[]>([]);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        loadPrimeWorks().then((next) => { if (alive) setWorks(next); }).catch(() => { if (alive) setFailed(true); });
        loadPrimeTasks().then((next) => { if (alive) setTasks(next); }).catch(() => { /* 任务源失败不阻断作品库 */ });
        return () => { alive = false; };
    }, []);
    return (
        <ToivShell>
            <ToivWorkbar face="edit" runningCount={tasks.filter((task) => task.status === "run").length}
                onFaceChange={(face) => navigate(face === "edit" ? "/history" : face === "canvas" ? "/drama" : "/studio")}
                onOpenTasks={() => document.querySelector(".toiv-history .toiv-assets-col:last-child")?.scrollIntoView({ behavior: "smooth" })} />
            <section className="toiv-history">
                <div className="toiv-assets-col">
                    <h3>作品 <span className="meta">{works.length}</span></h3>
                    {failed ? <div className="toiv-empty"><p>作品库载入失败</p></div> : null}
                    {!failed && works.length === 0 ? <div className="toiv-empty"><p>还没有产物。去流水线生成第一个镜头。</p></div> : null}
                    <div className="toiv-grid">
                        {works.map((work) => (
                            <article className="toiv-card" key={work.id}>
                                {work.media ? <img className="thumb" src={work.media} alt={work.title} /> : <div className="thumb">无预览</div>}
                                <header><b>{work.title}</b><span className={`flag flag-${work.status}`}>{work.status === "done" ? "完成" : work.status === "run" ? "生成中" : work.status === "fail" ? "失败" : "排队"}</span></header>
                                <div className="meta">{work.kind} · {work.createdAt}</div>
                            </article>
                        ))}
                    </div>
                </div>
                <div className="toiv-assets-col">
                    <h3>任务 <span className="meta">{tasks.length}</span></h3>
                    {tasks.map((task) => (
                        <div className="toiv-task" key={task.id}>
                            <div className="row">
                                <span className={`st st-${task.status}`} />
                                <span className="title">{task.title}</span>
                                {task.cancellable ? (
                                    <button type="button" className="cancel"
                                        onClick={() => { void cancelPrimeTask(task.id).then(() => loadPrimeTasks().then(setTasks)); }}>取消</button>
                                ) : null}
                            </div>
                        </div>
                    ))}
                    {tasks.length === 0 ? <p className="meta">队列空闲。</p> : null}
                </div>
            </section>
        </ToivShell>
    );
}
