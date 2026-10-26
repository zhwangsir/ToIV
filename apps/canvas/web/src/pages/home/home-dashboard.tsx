import { ArrowRight, Clapperboard, Loader2, Plus, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useCallback, useState } from "react";

import { beefTVCapabilityItems, homeIntentBarItems } from "./home-data";
import { ComputeStatusStrip } from "@/components/toiv/compute-status-strip";
import { createStudioProject, seedRainNightSample, type ToivDramaProject } from "@/services/toiv/client";

function formatDate(value?: string) {
    if (!value) return "刚刚更新";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚更新";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
}

export function HomeDashboard({
    projects,
    loading,
    error,
    onRetry,
}: {
    projects: ToivDramaProject[];
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
        <main className="toiv-home" aria-label="ToIV 首页">
            <section className="toiv-home-hero" aria-label="开始创作">
                <span className="toiv-home-glow" aria-hidden />
                <span className="toiv-home-glow toiv-home-glow-delay" aria-hidden />
                <div className="toiv-home-hero-actions">
                    <button type="button" className="toiv-home-create" onClick={() => void createDrama()} disabled={creating} aria-label="新建短剧">
                        <span className="toiv-home-create-icon">{creating ? <Loader2 className="animate-spin" /> : <Plus />}</span>
                        <span className="toiv-home-create-title">新建短剧</span>
                    </button>
                    <button
                        type="button"
                        className="toiv-home-secondary"
                        onClick={() => void openRainNight()}
                        disabled={seeding}
                        aria-label="打开雨夜示例"
                    >
                        {seeding ? <Loader2 className="size-4 animate-spin" /> : <Clapperboard className="size-4" />}
                        <span>打开雨夜示例</span>
                        <small>约 1 集示范 · 可对照学习</small>
                    </button>
                </div>
            </section>

            <ComputeStatusStrip variant="full" className="toiv-home-fleet-hint" />

            {actionError ? (
                <button className="toiv-home-error" type="button" onClick={() => setActionError(null)}>
                    {actionError}（点击关闭）
                </button>
            ) : null}

            <details className="toiv-home-more">
                <summary>更多能力</summary>
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
            </details>

            <section className="toiv-home-section toiv-recents">
                <header className="toiv-section-heading">
                    <h2>最近短剧</h2>
                    <Link to="/toiv/drama">查看全部 <ArrowRight /></Link>
                </header>
                {error ? (
                    <button className="toiv-home-error" type="button" onClick={onRetry}><RefreshCw />短剧列表读取失败，点击重试</button>
                ) : (
                    <div className="toiv-recent-grid">
                        {loading ? Array.from({ length: 4 }, (_, index) => <div className="toiv-recent-card is-loading" key={index} />) : projects.length ? projects.map((project) => (
                            <Link to={`/create?project=${encodeURIComponent(project.id)}`} className="toiv-recent-card" key={project.id}>
                                <span className="toiv-recent-preview"><Clapperboard /></span>
                                <span className="toiv-recent-copy">
                                    <strong>{project.title || project.premise?.slice(0, 24) || "未命名短剧"}</strong>
                                    <small>{formatDate(project.updated_at)}</small>
                                </span>
                                <ArrowRight className="toiv-recent-arrow" />
                            </Link>
                        )) : (
                            <button type="button" className="toiv-recent-card is-empty" onClick={() => void createDrama()} disabled={creating}>
                                <span className="toiv-recent-preview"><Plus /></span>
                                <span className="toiv-recent-copy"><strong>创建第一个短剧</strong></span>
                            </button>
                        )}
                    </div>
                )}
            </section>
        </main>
    );
}
