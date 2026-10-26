import { Clapperboard, FolderKanban, History, ImageIcon, Library, Sparkles } from "lucide-react";
import { Link } from "react-router";
import { useSyncExternalStore } from "react";

import { CreationProjectSwitcher } from "@/components/toiv/creation-project-switcher";
import { NsfwLockBadge } from "@/components/toiv/nsfw-lock-badge";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL, getR18ModeSnapshot, getServerR18ModeSnapshot, subscribeR18Mode } from "@/redline";

const LINKS = [
    { to: "/assets", label: "资产库", icon: Library, hint: "角色 / 场景 / 道具" },
    { to: "/toiv/library", label: "作品库", icon: FolderKanban, hint: "成片与素材" },
    { to: "/toiv/tasks", label: "任务中心", icon: History, hint: "生成队列" },
    { to: "/create", label: "自由创作", icon: Sparkles, hint: "无项目线程" },
] as const;

export function CreationStudioAssetRail({
    projectId,
    section = null,
}: {
    projectId: string | null;
    section?: string | null;
}) {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const q = (sec: string) =>
        projectId ? `/create?project=${encodeURIComponent(projectId)}&section=${encodeURIComponent(sec)}` : "/create";

    return (
        <div className="toiv-create-rail-inner">
            <header className="toiv-create-rail-head">
                <span className="toiv-create-rail-title">资产</span>
                <span className="toiv-create-rail-meta" title="内容模式只读；切换在顶栏光幕">
                    {adultOn ? <NsfwLockBadge /> : null}
                    {adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL}
                </span>
            </header>

            <div className="toiv-create-rail-block">
                <CreationProjectSwitcher projectId={projectId} />
            </div>

            <nav className="toiv-create-rail-nav" aria-label="资产入口">
                {projectId ? (
                    <>
                        <Link to={q("script")} className={"toiv-create-rail-link" + (section === "script" || !section ? " is-primary" : "")}>
                            <Clapperboard aria-hidden />
                            <span>
                                <strong>剧本解析</strong>
                                <em>中舞台正文 · 参数在右栏</em>
                            </span>
                        </Link>
                        <Link to={q("storyboard")} className={"toiv-create-rail-link" + (section === "storyboard" ? " is-primary" : "")}>
                            <ImageIcon aria-hidden />
                            <span>
                                <strong>分镜卡片</strong>
                                <em>阶段流 · 配景</em>
                            </span>
                        </Link>
                        <Link to={q("assets")} className={"toiv-create-rail-link" + (section === "assets" ? " is-primary" : "")}>
                            <Library aria-hidden />
                            <span>
                                <strong>项目资产</strong>
                                <em>定妆 / 三视图 / 引用</em>
                            </span>
                        </Link>
                        <Link to={q("shots")} className={"toiv-create-rail-link" + (section === "shots" ? " is-primary" : "")}>
                            <Clapperboard aria-hidden />
                            <span>
                                <strong>生成镜头</strong>
                                <em>主舞台渲染区</em>
                            </span>
                        </Link>
                    </>
                ) : (
                    <Link to="/assets" className="toiv-create-rail-link is-primary">
                        <ImageIcon aria-hidden />
                        <span>
                            <strong>项目资产</strong>
                            <em>定妆 / 三视图 / 引用</em>
                        </span>
                    </Link>
                )}
                {LINKS.map((item) => {
                    const Icon = item.icon;
                    return (
                        <Link key={item.to} to={item.to} className="toiv-create-rail-link">
                            <Icon aria-hidden />
                            <span>
                                <strong>{item.label}</strong>
                                <em>{item.hint}</em>
                            </span>
                        </Link>
                    );
                })}
            </nav>

            <p className="toiv-create-rail-footnote">
                主舞台留给剧本解析 / 分镜卡片 / 预览；表单进右侧 Inspector。普通/成人切换在<strong>顶栏光幕</strong>。
            </p>
        </div>
    );
}
