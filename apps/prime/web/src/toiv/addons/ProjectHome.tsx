import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ToivShell from "../shell/ToivShell";
import Button from "../../components/ui/Button";
import PillTabs from "../../components/ui/PillTabs";
import { IconEdit, IconPlus, IconSearch } from "../../components/ui/Icons";
import { loadPrimeProjects, type PrimeProjectsModel } from "../adapters/projects";
import { TaskDrawerPrime } from "./TaskDrawerPrime";
import type { PrimeFace } from "./ToivWorkbar";

const FACES: { key: PrimeFace; label: string; href: string }[] = [
    { key: "pipeline", label: "流水线", href: "/studio" },
    { key: "canvas", label: "画布", href: "/drama" },
    { key: "edit", label: "剪辑湾", href: "/studio?face=edit" },
];
const SOURCES = ["全部项目", "Studio 项目", "画布项目"];
const STATUS_LABELS: Record<string, string> = {
    draft: "草稿", running: "进行中", rendering: "渲染中", processing: "处理中",
    done: "已完成", succeeded: "已完成", failed: "失败", error: "失败",
};

function openHrefDefault(card: { source: "studio" | "canvas"; id: string }, face: PrimeFace) {
    if (card.source === "canvas") return `/legacy/canvas/${card.id}`;
    if (face === "edit") return `/studio/${card.id}/editor`;
    return face === "canvas" ? `/drama/projects/${card.id}/canvas` : `/studio/${card.id}`;
}

export default function ProjectHome({ face = "pipeline", openHref }: { face?: PrimeFace; openHref?: (card: { source: "studio" | "canvas"; id: string }) => string }) {
    const navigate = useNavigate();
    const location = useLocation();
    const currentFace = new URLSearchParams(location.search).get("face") === "edit" ? "edit" : face;
    const [model, setModel] = useState<PrimeProjectsModel | null>(null);
    const [loading, setLoading] = useState(true);
    const [request, setRequest] = useState(0);
    const [query, setQuery] = useState("");
    const [source, setSource] = useState(SOURCES[0]);
    const [tasksOpen, setTasksOpen] = useState(false);
    useEffect(() => {
        let alive = true;
        setLoading(true);
        loadPrimeProjects()
            .then((next) => { if (alive) setModel(next); })
            .catch(() => { if (alive) setModel({ cards: [], degraded: "both" }); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [request]);
    const retry = () => { setLoading(true); setRequest((value) => value + 1); };
    const search = query.trim().toLocaleLowerCase();
    const cards = (model?.cards ?? []).filter((card) =>
        card.title.toLocaleLowerCase().includes(search) &&
        (source === SOURCES[0] || (source === SOURCES[1] ? card.source === "studio" : card.source === "canvas")),
    );
    const failed = model?.degraded === "both";
    const partial = model?.degraded === "studio" || model?.degraded === "canvas";
    const filtered = Boolean(search) || source !== SOURCES[0];
    const assets = location.pathname === "/drama/assets";

    return (
        <ToivShell>
            <section className="toiv-home">
                <div className="pf-history-head">
                    <div>
                        <h1>{assets ? "项目资产" : currentFace === "edit" ? "项目剪辑" : "项目"}</h1>
                        <p>{assets ? "选择项目，管理角色、场景与素材。" : currentFace === "edit" ? "选择 Studio 项目，继续剪辑与时间线编辑。" : "从剧本到画布，继续你的创作。"}</p>
                    </div>
                    <div className="pf-history-head-actions">
                        <Button variant="lime" icon to="/studio/new"><IconPlus size={16} />新建项目</Button>
                    </div>
                </div>
                <div className="toiv-workbar" role="toolbar" aria-label="ToIV 工作面">
                    <span className="toiv-workbar-faces" role="group" aria-label="工作面">
                        {FACES.map((item) => (
                            <Button key={item.key} variant={item.key === currentFace ? "dark" : "ghost"}
                                aria-pressed={item.key === currentFace} onClick={() => navigate(item.href)}>
                                {item.label}
                            </Button>
                        ))}
                    </span>
                    <Button variant="ghost" size="sm" aria-label="打开任务中心" onClick={() => setTasksOpen(true)}>任务中心</Button>
                </div>
                <div className="pf-history-layout">
                    <section className="pf-history-main" aria-label="项目列表" aria-busy={loading}>
                        <div className="pf-history-filters">
                            <PillTabs items={SOURCES} value={source} onChange={setSource} ariaLabel="项目来源" />
                            <div className="pf-history-filter-right">
                                <label className="pf-search-field">
                                    <IconSearch size={15} />
                                    <input aria-label="搜索项目" placeholder="搜索项目…" value={query} onChange={(event) => setQuery(event.target.value)} />
                                </label>
                            </div>
                        </div>
                        {loading ? <p className="pf-muted" role="status">正在加载项目…</p> : null}
                        {failed || partial ? (
                            <div className="toiv-degraded" role="alert">
                                <p>{failed ? "项目加载失败：Studio 与画布项目源均不可用。" : `${model?.degraded === "studio" ? "Studio 项目源" : "画布项目源"}加载失败 · 已显示其余来源`}</p>
                                <Button variant="outline" size="sm" disabled={loading} onClick={retry}>{loading ? "重试中…" : "重试"}</Button>
                            </div>
                        ) : null}
                        {!loading && !failed ? (
                            <>
                                <p className="pf-muted">{partial ? "当前可用来源 · " : ""}{cards.length} 个项目</p>
                                {cards.length === 0 ? (
                                    <div className="pf-history-empty">
                                        <p>{filtered ? "没有匹配的项目。试试其他标题或来源。" : partial ? "可用来源中暂无项目，请重试恢复其余来源。" : "还没有项目。从一段剧本或一张参考图开始。"}</p>
                                        {filtered ? <Button variant="ghost" onClick={() => { setQuery(""); setSource(SOURCES[0]); }}>清除筛选</Button> : !partial ? <Button variant="lime" to="/studio/new">新建项目</Button> : null}
                                    </div>
                                ) : null}
                            </>
                        ) : null}
                        {cards.length > 0 ? (
                            <div className="pf-project-list">
                                {cards.map((card) => {
                                    const href = openHref ? openHref(card) : openHrefDefault(card, currentFace);
                                    return (
                                        <article className="pf-project-card" key={`${card.source}:${card.id}`}>
                                            <button type="button" className="pf-project-thumb" aria-label={`打开项目 ${card.title}`} onClick={() => navigate(href)}>
                                                <div className="ph">暂无封面</div>
                                            </button>
                                            <div className="pf-project-info">
                                                <h3>{card.title}</h3>
                                                <div className="pf-project-meta">
                                                    <span className="pf-badge">{card.source === "canvas" ? "画布" : "Studio"}</span>
                                                    {card.source === "studio" ? <span className="pf-badge">{STATUS_LABELS[card.status.toLowerCase()] || card.status}</span> : null}
                                                    {card.source === "studio" && card.shotCount > 0 ? <span className="pf-muted">{card.shotCount} 镜头</span> : null}
                                                </div>
                                            </div>
                                            <div className="pf-project-actions">
                                                <Button variant="text" size="sm" icon to={href}><IconEdit size={14} />{currentFace === "edit" && card.source === "studio" && !openHref ? "继续剪辑" : "打开项目"}</Button>
                                                {card.source === "studio" ? <Button variant="text" size="sm" to={`/drama/projects/${card.id}/assets`}>资产</Button> : null}
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        ) : null}
                    </section>
                </div>
            </section>
            <TaskDrawerPrime open={tasksOpen} onClose={() => setTasksOpen(false)} />
        </ToivShell>
    );
}
