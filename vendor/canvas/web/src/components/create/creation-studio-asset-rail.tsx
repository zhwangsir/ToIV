import { BookMarked, Clapperboard, FolderKanban, History, ImageIcon, Library } from "lucide-react";
import { Link } from "react-router";
import { useSyncExternalStore } from "react";

import { CreationStudioMediaPool } from "@/components/create/creation-studio-media-pool";
import { CreationProjectSwitcher } from "@/components/toiv/creation-project-switcher";
import { ProjectBiblePanel } from "@/components/toiv/project-bible-panel";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL, getR18ModeSnapshot, getServerR18ModeSnapshot, subscribeR18Mode } from "@/redline";

const LINKS = [
    { to: "/assets", label: "资产库", icon: Library, hint: "角色 / 场景 / 道具" },
    { to: "/toiv/library", label: "作品库", icon: FolderKanban, hint: "成片与素材" },
    { to: "/toiv/tasks", label: "任务中心", icon: History, hint: "生成队列" },
    { to: "/create", label: "自由创作", icon: Clapperboard, hint: "无项目线程" },
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
                <span className="toiv-create-rail-meta" aria-label={`内容模式：${adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL}`}>
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
                                <em>剧本与分场</em>
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
                                <em>镜头与预览</em>
                            </span>
                        </Link>
                        <Link to={q("bible")} className={"toiv-create-rail-link" + (section === "bible" ? " is-primary" : "")} data-testid="creation-rail-bible">
                            <BookMarked aria-hidden />
                            <span>
                                <strong>设定圣经</strong>
                                <em>ProjectBible · 钉版只读</em>
                            </span>
                        </Link>
                    </>
                ) : (
                    <>
                        <Link to="/assets" className="toiv-create-rail-link is-primary">
                            <ImageIcon aria-hidden />
                            <span>
                                <strong>项目资产</strong>
                                <em>定妆 / 三视图 / 引用</em>
                            </span>
                        </Link>
                        <Link
                            to="/create?section=bible"
                            className={"toiv-create-rail-link" + (section === "bible" ? " is-primary" : "")}
                            data-testid="creation-rail-bible"
                        >
                            <BookMarked aria-hidden />
                            <span>
                                <strong>设定圣经</strong>
                                <em>ProjectBible · 钉版只读</em>
                            </span>
                        </Link>
                    </>
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

            <CreationStudioMediaPool projectId={projectId} />

            {section === "bible" ? null : (
                <div className="toiv-create-rail-block" data-testid="creation-rail-bible-compact">
                    <ProjectBiblePanel variant="rail" />
                </div>
            )}
        </div>
    );
}
