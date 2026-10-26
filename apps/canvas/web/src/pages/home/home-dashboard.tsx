import { ArrowRight, Clapperboard, Loader2, Plus, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useCallback, useState } from "react";

import { beefTVCapabilityItems, homeIntentBarItems } from "./home-data";
import { ComputeStatusStrip } from "@/components/toiv/compute-status-strip";
import { createStudioProject, seedRainNightSample, type ToivDramaProject } from "@/services/toiv/client";
import "@/styles/toiv-freezone-desk.css";
import "./home-dashboard.css";

function formatDate(value?: string) {
    if (!value) return "刚刚更新";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚更新";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
}

const PHASE_PIPS = ["剧本", "资产", "分镜", "成片"] as const;

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
        <main className="toiv-home fz-desk fz-desk-page" aria-label="ToIV 首页">
            <header className="fz-desk-toolbar" aria-label="工作台工具条">
                <h1>工作台</h1>
                <div className="fz-desk-actions">
                    <button type="button" className="fz-btn is-primary" onClick={() => void createDrama()} disabled={creating} aria-label="新建短剧">
                        {creating ? <Loader2 className="animate-spin" /> : <Plus />}
                        新建短剧
                    </button>
                    <button type="button" className="fz-btn" onClick={() => void openRainNight()} disabled={seeding} aria-label="打开雨夜示例">
                        {seeding ? <Loader2 className="animate-spin" /> : <Clapperboard />}
                        雨夜示例
                    </button>
                    <Link to="/create" className="fz-btn">去创作</Link>
                </div>
                <p>密台 · 最近项目优先 · Freezone 暗壳</p>
            </header>

            <ComputeStatusStrip variant="full" className="toiv-home-fleet-hint" />

            {actionError ? (
                <button className="toiv-home-error" type="button" onClick={() => setActionError(null)}>
                    {actionError}（点击关闭）
                </button>
            ) : null}

            <section className="toiv-home-section toiv-recents" aria-label="最近短剧">
                <header className="fz-section-head">
                    <h2>最近短剧</h2>
                    <Link to="/toiv/drama">全部 <ArrowRight className="inline size-3.5" /></Link>
                </header>
                {error ? (
                    <button className="toiv-home-error" type="button" onClick={onRetry}>
                        <RefreshCw />短剧列表读取失败，点击重试
                    </button>
                ) : (
                    <div className="fz-dense-grid">
                        {loading
                            ? Array.from({ length: 6 }, (_, index) => <div className="fz-card is-loading toiv-recent-card is-loading" key={index} />)
                            : projects.length
                              ? projects.map((project) => (
                                    <Link to={`/create?project=${encodeURIComponent(project.id)}`} className="fz-card" key={project.id}>
                                        <p className="fz-card-title">{project.title || project.premise?.slice(0, 24) || "未命名短剧"}</p>
                                        <p className="fz-card-meta">{formatDate(project.updated_at)}</p>
                                        <div className="fz-phase-row" aria-hidden>
                                            {PHASE_PIPS.map((label, i) => (
                                                <span key={label} className={i === 0 ? "fz-phase-pip is-done" : "fz-phase-pip"}>
                                                    {label}
                                                </span>
                                            ))}
                                        </div>
                                    </Link>
                                ))
                              : (
                                    <button type="button" className="fz-card" onClick={() => void createDrama()} disabled={creating}>
                                        <p className="fz-card-title">创建第一个短剧</p>
                                        <p className="fz-card-meta">进入六段工作区</p>
                                    </button>
                                )}
                    </div>
                )}
            </section>

            <section className="toiv-home-section" aria-label="快捷入口">
                <header className="fz-section-head">
                    <h2>快捷</h2>
                </header>
                <div className="fz-chip-row">
                    {homeIntentBarItems.map(({ id, label, detail, to, icon: Icon }) => (
                        <Link key={id} to={to} className="fz-chip" title={detail}>
                            <Icon aria-hidden />
                            {label}
                        </Link>
                    ))}
                    {beefTVCapabilityItems
                        .filter((x) => !x.disabled)
                        .slice(0, 6)
                        .map(({ id, label, to, icon: Icon, external }) =>
                            external ? (
                                <a key={id} href={to} className="fz-chip">
                                    <Icon aria-hidden />
                                    {label}
                                </a>
                            ) : (
                                <Link key={id} to={to} className="fz-chip">
                                    <Icon aria-hidden />
                                    {label}
                                </Link>
                            ),
                        )}
                </div>
            </section>
        </main>
    );
}
