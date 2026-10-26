import { Clapperboard, FolderKanban, History, ImageIcon, Library, Sparkles } from "lucide-react";
import { Link } from "react-router";

import { CreationProjectSwitcher } from "@/components/toiv/creation-project-switcher";
import { NsfwLockBadge } from "@/components/toiv/nsfw-lock-badge";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL, getR18ModeSnapshot, getServerR18ModeSnapshot, subscribeR18Mode } from "@/redline";
import { useSyncExternalStore } from "react";

const LINKS = [
    { to: "/assets", label: "资产库", icon: Library, hint: "角色 / 场景 / 道具" },
    { to: "/toiv/library", label: "作品库", icon: FolderKanban, hint: "成片与素材" },
    { to: "/toiv/tasks", label: "任务中心", icon: History, hint: "生成队列" },
    { to: "/create", label: "自由创作", icon: Sparkles, hint: "无项目线程" },
] as const;

export function CreationStudioAssetRail({ projectId }: { projectId: string | null }) {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const assetsHref = projectId
        ? `/create?project=${encodeURIComponent(projectId)}&section=assets`
        : "/assets";

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
                <Link to={assetsHref} className="toiv-create-rail-link is-primary">
                    <ImageIcon aria-hidden />
                    <span>
                        <strong>项目资产</strong>
                        <em>定妆 / 三视图 / 引用</em>
                    </span>
                </Link>
                {projectId ? (
                    <Link
                        to={`/create?project=${encodeURIComponent(projectId)}&section=shots`}
                        className="toiv-create-rail-link"
                    >
                        <Clapperboard aria-hidden />
                        <span>
                            <strong>分镜 / 镜头</strong>
                            <em>主舞台生成区</em>
                        </span>
                    </Link>
                ) : null}
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
                主舞台留给预览 / 时间线 / 对话；字段进右侧 Inspector。普通/成人切换在<strong>顶栏光幕</strong>。
            </p>
        </div>
    );
}
