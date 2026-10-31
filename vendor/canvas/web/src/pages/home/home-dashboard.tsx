import { ArrowRight, Clapperboard, Loader2, Plus, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useCallback, useState } from "react";

import type { CanvasLibrarySummary } from "@/services/api/workspace-data";
import { ProjectPreview } from "@/components/canvas/canvas-project-card";
import { ComputeStatusStrip } from "@/components/toiv/compute-status-strip";
import { createStudioProject, seedRainNightSample } from "@/services/toiv/client";
import { beefTVCapabilityItems } from "./home-data";
import "./home-dashboard.css";

function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚更新";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
}

/**
 * W6 · 首页降级面（默认落地 /create）。
 * Hero = 去创作台；禁主推新建画布；capability 无 /canvas；最近 = 自由画布专家轨预览。
 * homeIntentBarItems / HOME_INTENT_ENTRIES 禁止整墙铺首页（export 仍留给工具台/市场）。
 */
export function HomeDashboard({
    projects,
    loading,
    error,
    onRetry,
}: {
    projects: CanvasLibrarySummary[];
    loading: boolean;
    error: boolean;
    onRetry: () => void;
}) {
    const navigate = useNavigate();
    const [creating, setCreating] = useState(false);
    const [seeding, setSeeding] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const createDrama = useCallback(async () => {
        if (creating) return;
        setCreating(true);
        setActionError(null);
        try {
            const project = await createStudioProject({ title: "未命名短剧" });
            navigate(`/create?project=${encodeURIComponent(project.id)}&section=script`);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : "新建短剧失败，请稍后重试");
        } finally {
            setCreating(false);
        }
    }, [creating, navigate]);

    const openRainNight = useCallback(async () => {
        if (seeding) return;
        setSeeding(true);
        setActionError(null);
        try {
            const sample = await seedRainNightSample();
            navigate(`/create?project=${encodeURIComponent(sample.id)}&section=script`);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : "打开雨夜示例失败，请稍后重试");
        } finally {
            setSeeding(false);
        }
    }, [navigate, seeding]);

    return (
        <main className="beeftv-home toiv-home" aria-label="ToIV 首页">
            <section className="beeftv-home-hero" aria-label="去创作台">
                <span className="beeftv-home-dot-base" aria-hidden />
                <span className="beeftv-home-dot-flow" aria-hidden />
                <span className="beeftv-home-dot-flow beeftv-home-dot-flow-delay" aria-hidden />
                <button type="button" className="beeftv-home-create" onClick={() => navigate("/create")}>
                    <span className="beeftv-home-create-icon"><Plus /></span>
                    <span className="beeftv-home-create-title">打开创作台</span>
                </button>
            </section>

            <div className="beeftv-home-meta" aria-label="算力与次入口">
                <ComputeStatusStrip variant="compact" className="beeftv-home-compute" />
                <div className="beeftv-home-secondary">
                    <button type="button" className="beeftv-home-secondary-btn" onClick={() => void createDrama()} disabled={creating} aria-label="新建短剧">
                        {creating ? <Loader2 className="animate-spin" /> : <Clapperboard />}
                        新建短剧
                    </button>
                    <button type="button" className="beeftv-home-secondary-btn" onClick={() => void openRainNight()} disabled={seeding} aria-label="打开雨夜示例">
                        {seeding ? <Loader2 className="animate-spin" /> : <Clapperboard />}
                        雨夜示例
                    </button>
                </div>
            </div>

            {actionError ? (
                <button className="beeftv-home-error" type="button" onClick={() => setActionError(null)}>
                    {actionError}（点击关闭）
                </button>
            ) : null}

            <nav className="beeftv-capabilities" aria-label="创作能力">
                {beefTVCapabilityItems.map(({ id, label, detail, to, icon: Icon, disabled, external }) => (
                    disabled ? (
                        <span key={id} className="beeftv-capability is-disabled" aria-disabled="true" title={`${label}：${detail}`}>
                            <span className="beeftv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </span>
                    ) : external ? (
                        <a key={id} href={to} className="beeftv-capability" title={detail}>
                            <span className="beeftv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </a>
                    ) : (
                        <Link key={id} to={to} className="beeftv-capability" title={detail}>
                            <span className="beeftv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </Link>
                    )
                ))}
            </nav>

            <section className="beeftv-home-section beeftv-recents" aria-label="最近自由画布（专家）">
                <header className="beeftv-section-heading">
                    <h2>最近自由画布（专家）</h2>
                    <Link to="/project">查看画布库 <ArrowRight /></Link>
                </header>
                {error ? (
                    <button className="beeftv-home-error" type="button" onClick={onRetry}>
                        <RefreshCw />自由画布读取失败，点击重试
                    </button>
                ) : (
                    <div className="beeftv-recent-grid">
                        {loading ? (
                            Array.from({ length: 4 }, (_, index) => <div className="beeftv-recent-card is-loading" key={index} />)
                        ) : projects.length ? (
                            projects.map((project) => (
                                <Link to={`/canvas/${project.id}`} className="beeftv-recent-card" key={project.id}>
                                    <span className="beeftv-recent-preview">
                                        <ProjectPreview project={{ id: project.id, nodes: project.previewNodes }} emptyVariant="libtv" />
                                    </span>
                                    <span className="beeftv-recent-copy">
                                        <strong>{project.title || "未命名"}</strong>
                                        <small>{formatDate(project.updatedAt)}</small>
                                    </span>
                                    <ArrowRight className="beeftv-recent-arrow" />
                                </Link>
                            ))
                        ) : (
                            <button type="button" className="beeftv-recent-card is-empty" onClick={() => navigate("/create")}>
                                <span className="beeftv-recent-preview"><Plus /></span>
                                <span className="beeftv-recent-copy">
                                    <strong>去创作台开始</strong>
                                    <small>密台创作是默认主意图</small>
                                </span>
                            </button>
                        )}
                    </div>
                )}
            </section>
        </main>
    );
}
