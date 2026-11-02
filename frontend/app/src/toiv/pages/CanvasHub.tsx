import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../../components/ui/Button";
import { IconClapper, IconPlus, IconSearch } from "../../components/ui/Icons";
import { dramaApi } from "../../api/drama";
import {
    formatRelativeTime,
    loadPrimeProjects,
    type PrimeProjectCard,
    type PrimeProjectsModel,
} from "../adapters/projects";
import { toivMediaUrl } from "../adapters/media";
import ToivShell from "../shell/ToivShell";

const CANVAS_PLACEHOLDER = "自由画布创作项目，稍后在画布中完善故事与资产。";

function cardCover(card: PrimeProjectCard) {
    const src = card.coverUrl ? toivMediaUrl(card.coverUrl) : "";
    return card.coverKind === "video" ? `${src}#t=0.1` : src;
}

/** K1: Studio 源进 Freezone；canvas 源仅深链 legacy（旧画布徽）。 */
function canvasHref(card: PrimeProjectCard) {
    return card.source === "canvas" ? `/legacy/canvas/${card.id}` : `/drama/projects/${card.id}/freezone`;
}

export default function CanvasHub() {
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeProjectsModel | null>(null);
    const [loading, setLoading] = useState(true);
    const [request, setRequest] = useState(0);
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState("");

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
    const cards = (model?.cards ?? []).filter((card) => card.title.toLocaleLowerCase().includes(search));
    const failed = model?.degraded === "both";
    const partial = model?.degraded === "studio" || model?.degraded === "canvas";
    const filtered = Boolean(search);

    async function enterFreeCanvas() {
        if (creating) return;
        setCreating(true);
        setCreateError("");
        try {
            const project = await dramaApi.createProject({
                source: CANVAS_PLACEHOLDER,
                episode_count: 1,
                title: "自由画布项目",
                workflow: "canvas",
            });
            navigate(`/drama/projects/${project.id}/freezone`);
        } catch (cause) {
            setCreateError(cause instanceof Error ? cause.message : "创建画布项目失败");
        } finally {
            setCreating(false);
        }
    }

    return (
        <ToivShell>
            <section className="toiv-home toiv-canvas-hub">
                <div className="pf-history-head">
                    <div>
                        <h1>画布</h1>
                        <p>选一个项目打开 Freezone 自由画布；也可直接开一张新画布。</p>
                    </div>
                    <div className="pf-history-head-actions">
                        <Button variant="lime" icon disabled={creating} onClick={() => void enterFreeCanvas()}>
                            <IconPlus size={16} />{creating ? "创建中…" : "自由画布"}
                        </Button>
                    </div>
                </div>
                {createError ? <div className="toiv-degraded" role="alert"><p>{createError}</p></div> : null}
                <div className="pf-history-layout">
                    <section className="pf-history-main" aria-label="画布项目" aria-busy={loading}>
                        <div className="pf-history-filters">
                            <label className="pf-search-field">
                                <IconSearch size={15} />
                                <input aria-label="搜索项目" placeholder="搜索项目…" value={query} onChange={(event) => setQuery(event.target.value)} />
                            </label>
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
                                <p className="pf-muted">{partial ? "当前可用来源 · " : ""}{cards.length} 个可打开</p>
                                {cards.length === 0 ? (
                                    filtered || partial ? (
                                        <div className="pf-history-empty">
                                            <p>{filtered ? "没有匹配的项目。试试其他标题。" : "可用来源中暂无项目，请重试恢复其余来源。"}</p>
                                            {filtered ? <Button variant="ghost" onClick={() => setQuery("")}>清除筛选</Button> : null}
                                        </div>
                                    ) : (
                                        <div className="pf-history-empty toiv-empty-brand">
                                            <span className="toiv-empty-mark" aria-hidden="true"><IconClapper size={24} /></span>
                                            <h2>还没有可打开的画布</h2>
                                            <p>选一个已有项目进入 Freezone，或先开一张自由画布（创建后进入 Freezone `/drama/projects/:id/freezone`）。</p>
                                            <div className="toiv-empty-actions">
                                                <Button variant="lime" disabled={creating} onClick={() => void enterFreeCanvas()}>
                                                    {creating ? "创建中…" : "进入自由画布"}
                                                </Button>
                                                <Button variant="ghost" to="/studio">去项目库</Button>
                                            </div>
                                        </div>
                                    )
                                ) : null}
                            </>
                        ) : null}
                        {cards.length > 0 ? (
                            <div className="pf-project-list is-gallery">
                                {cards.map((card) => {
                                    const href = canvasHref(card);
                                    const cover = cardCover(card);
                                    const updated = formatRelativeTime(card.updatedAt);
                                    return (
                                        <article className="pf-project-card" key={`${card.source}:${card.id}`}>
                                            <button type="button" className="pf-project-thumb" aria-label={`打开项目 ${card.title}`} onClick={() => navigate(href)}>
                                                {cover && card.coverKind === "video" ? (
                                                    <video src={cover} muted playsInline preload="metadata" aria-label={`${card.title} 封面`} />
                                                ) : cover ? (
                                                    <img src={cover} alt={`${card.title} 封面`} loading="lazy" />
                                                ) : (
                                                    <div className="ph">暂无封面</div>
                                                )}
                                            </button>
                                            <div className="pf-project-info">
                                                <h3>{card.title}</h3>
                                                <div className="pf-project-meta">
                                                    <span className="pf-badge">{card.source === "canvas" ? "旧画布" : "Studio"}</span>
                                                    {updated ? <span className="pf-muted">更新于 {updated}</span> : null}
                                                </div>
                                            </div>
                                            <div className="pf-project-actions">
                                                <Button variant="text" size="sm" to={href}>进入画布</Button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        ) : null}
                    </section>
                </div>
            </section>
        </ToivShell>
    );
}
