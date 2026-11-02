import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../../components/ui/Button";
import { IconClapper, IconSearch } from "../../components/ui/Icons";
import {
    formatRelativeTime,
    loadPrimeProjects,
    type PrimeProjectCard,
    type PrimeProjectsModel,
} from "../adapters/projects";
import { toivMediaUrl } from "../adapters/media";
import ToivShell from "../shell/ToivShell";

function cardCover(card: PrimeProjectCard) {
    const src = card.coverUrl ? toivMediaUrl(card.coverUrl) : "";
    return card.coverKind === "video" ? `${src}#t=0.1` : src;
}

/** 资产库：选项目索引 → 项目内 PrimeAssets。 */
export default function AssetsHub() {
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeProjectsModel | null>(null);
    const [loading, setLoading] = useState(true);
    const [request, setRequest] = useState(0);
    const [query, setQuery] = useState("");

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
    // 资产真面按项目组织；与 ProjectHome 卡片「资产」钮一致，索引以 Studio 为主，画布源仍可点进同一 path（失败由真面提示）。
    const cards = (model?.cards ?? []).filter((card) => card.title.toLocaleLowerCase().includes(search));
    const failed = model?.degraded === "both";
    const partial = model?.degraded === "studio" || model?.degraded === "canvas";
    const filtered = Boolean(search);

    return (
        <ToivShell>
            <section className="toiv-home toiv-assets-hub">
                <div className="pf-history-head">
                    <div>
                        <h1>资产库</h1>
                        <p>先选项目，再管理角色/场景/素材。</p>
                    </div>
                    <div className="pf-history-head-actions">
                        <Button variant="ghost" to="/studio">去项目库</Button>
                    </div>
                </div>
                <div className="pf-history-layout">
                    <section className="pf-history-main" aria-label="资产项目索引" aria-busy={loading}>
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
                                <p className="pf-muted">{partial ? "当前可用来源 · " : ""}{cards.length} 个项目</p>
                                {cards.length === 0 ? (
                                    filtered || partial ? (
                                        <div className="pf-history-empty">
                                            <p>{filtered ? "没有匹配的项目。试试其他标题。" : "可用来源中暂无项目，请重试恢复其余来源。"}</p>
                                            {filtered ? <Button variant="ghost" onClick={() => setQuery("")}>清除筛选</Button> : null}
                                        </div>
                                    ) : (
                                        <div className="pf-history-empty toiv-empty-brand">
                                            <span className="toiv-empty-mark" aria-hidden="true"><IconClapper size={24} /></span>
                                            <h2>还没有可管理的项目</h2>
                                            <p>先到项目库创建 Studio 项目，再回来管理角色、场景与素材。</p>
                                            <div className="toiv-empty-actions">
                                                <Button variant="lime" to="/studio/new">新建项目</Button>
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
                                    const href = `/drama/projects/${card.id}/assets`;
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
                                                <Button variant="text" size="sm" to={href}>管理资产</Button>
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
