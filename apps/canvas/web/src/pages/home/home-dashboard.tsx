import { ArrowRight, Plus, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import type { CanvasLibrarySummary } from "@/services/api/workspace-data";
import { ProjectPreview } from "@/components/canvas/canvas-project-card";
import { beefTVCapabilityItems, homeIntentBarItems } from "./home-data";
function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚更新";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
}

export function HomeDashboard({ projects, loading, error, onRetry }: { projects: CanvasLibrarySummary[]; loading: boolean; error: boolean; onRetry: () => void }) {
    const navigate = useNavigate();
    return (
        <main className="toiv-home" aria-label="ToIV 首页">
            <section className="toiv-home-hero" aria-label="新建画布">
                <span className="toiv-home-dot-base" aria-hidden />
                <span className="toiv-home-dot-flow" aria-hidden />
                <span className="toiv-home-dot-flow toiv-home-dot-flow-delay" aria-hidden />
                <button type="button" className="toiv-home-create" onClick={() => navigate("/canvas?mode=new")}>
                    <span className="toiv-home-create-icon"><Plus /></span>
                    <span className="toiv-home-create-title">新建画布创作</span>
                </button>
            </section>

            <nav className="toiv-capabilities" aria-label="创作能力">
                {beefTVCapabilityItems.map(({ id, label, detail, to, icon: Icon, disabled, external }) => (
                    disabled ? (
                        <span key={id} className="toiv-capability is-disabled" aria-disabled="true" title={`${label}：${detail}`}>
                            <span className="toiv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </span>
                    ) : external ? (
                        <a key={id} href={to} className="toiv-capability">
                            <span className="toiv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </a>
                    ) : (
                        <Link key={id} to={to} className="toiv-capability">
                            <span className="toiv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </Link>
                    )
                ))}
            </nav>

            <nav className="toiv-intent-bar" aria-label="意图">
                {homeIntentBarItems.map(({ id, label, detail, to, icon: Icon }) => (
                    <Link key={id} to={to} className="toiv-intent-chip" title={detail}>
                        <Icon aria-hidden />
                        <span>{label}</span>
                    </Link>
                ))}
            </nav>

            <section className="toiv-home-section toiv-recents">
                <header className="toiv-section-heading"><h2>最近项目</h2><Link to="/project">查看全部 <ArrowRight /></Link></header>
                {error ? (
                    <button className="toiv-home-error" type="button" onClick={onRetry}><RefreshCw />画布读取失败，点击重试</button>
                ) : (
                    <div className="toiv-recent-grid">
                        {loading ? Array.from({ length: 4 }, (_, index) => <div className="toiv-recent-card is-loading" key={index} />) : projects.length ? projects.map((project) => {
                            return <Link to={`/canvas/${project.id}`} className="toiv-recent-card" key={project.id}>
                                <span className="toiv-recent-preview"><ProjectPreview project={{ id: project.id, nodes: project.previewNodes }} emptyVariant="libtv" /></span>
                                <span className="toiv-recent-copy"><strong>{project.title || "未命名"}</strong><small>{formatDate(project.updatedAt)}</small></span>
                                <ArrowRight className="toiv-recent-arrow" />
                            </Link>;
                        }) : <button type="button" className="toiv-recent-card is-empty" onClick={() => navigate("/canvas?mode=new")}><span className="toiv-recent-preview"><Plus /></span><span className="toiv-recent-copy"><strong>创建第一个画布</strong></span></button>}
                    </div>
                )}
            </section>
        </main>
    );
}
