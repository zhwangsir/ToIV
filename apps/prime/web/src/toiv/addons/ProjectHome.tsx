import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ToivShell from "../shell/ToivShell";
import Button from "../../components/ui/Button";
import { loadPrimeProjects, type PrimeProjectsModel } from "../adapters/projects";
import { TaskDrawerPrime } from "./TaskDrawerPrime";
import { ToivWorkbar, type PrimeFace } from "./ToivWorkbar";

const FACE_HREF: Record<PrimeFace, string> = { pipeline: "/studio", canvas: "/drama", edit: "/history" };

function openHrefDefault(card: { source: "studio" | "canvas"; id: string }, face: PrimeFace) {
    if (card.source === "canvas") return `/legacy/canvas/${card.id}`;
    return face === "canvas" ? `/drama/projects/${card.id}/canvas` : `/studio/${card.id}`;
}

export default function ProjectHome({ face = "pipeline", openHref }: { face?: PrimeFace; openHref?: (card: { source: "studio" | "canvas"; id: string }) => string }) {
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeProjectsModel | null>(null);
    const [query, setQuery] = useState("");
    const [tasksOpen, setTasksOpen] = useState(false);
    useEffect(() => {
        let alive = true;
        loadPrimeProjects().then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setModel({ cards: [], degraded: "studio" }); });
        return () => { alive = false; };
    }, []);
    const cards = (model?.cards ?? []).filter((card) => card.title.includes(query.trim()));
    return (
        <ToivShell>
            <ToivWorkbar face={face} runningCount={0}
                onFaceChange={(face) => navigate(FACE_HREF[face])} onOpenTasks={() => setTasksOpen(true)} />
            <section className="toiv-home">
                <header className="toiv-home-bar">
                    <h2>项目</h2><span className="meta">{cards.length} 个项目</span>
                    <span className="right">
                        <input aria-label="搜索项目" placeholder="搜索项目…" value={query} onChange={(event) => setQuery(event.target.value)} />
                        <Button variant="lime" onClick={() => navigate("/studio/new")}>新建项目</Button>
                    </span>
                </header>
                {model?.degraded && model.degraded !== "none" ? (
                    <p className="toiv-degraded" role="alert">{model.degraded === "studio" ? "Studio 项目源加载失败 · 已显示其余来源" : "画布项目源加载失败 · 已显示其余来源"}</p>
                ) : null}
                {cards.length === 0 ? (
                    <div className="toiv-empty">
                        <p>还没有项目。从一段剧本或一张参考图开始。</p>
                        <Button variant="lime" onClick={() => navigate("/studio/new")}>新建项目</Button>
                    </div>
                ) : (
                    <div className="toiv-grid">
                        {cards.map((card) => (
                            <article className="toiv-card" key={`${card.source}:${card.id}`}>
                                <header><b>{card.title}</b><span className={`src src-${card.source}`}>{card.source === "canvas" ? "画布" : "Studio"}</span></header>
                                <div className="meta">{card.shotCount} 镜 · {card.status}</div>
                                <footer>
                                    <Button variant="ghost" size="sm" onClick={() => navigate(openHref ? openHref(card) : openHrefDefault(card, face))}>打开</Button>
                                </footer>
                            </article>
                        ))}
                    </div>
                )}
            </section>
            <TaskDrawerPrime open={tasksOpen} onClose={() => setTasksOpen(false)} />
        </ToivShell>
    );
}
