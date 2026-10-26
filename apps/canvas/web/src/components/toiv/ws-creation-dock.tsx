/**
 * Wave0：短剧工作区创作坞 — 选模 + 关键参 + 近史同屏（学 Toonflow 少跳页；NSFW 走 redline）。
 */
import { History, Layers, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";

import { ModelPicker } from "@/components/model-picker";
import { NsfwLockBadge } from "@/components/toiv/nsfw-lock-badge";
import { ContentModeFallbackTip } from "@/components/toiv/content-mode-fallback-tip";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL, COPY_NSFW_MODELS_HIDDEN_EMPTY, R18_SETTINGS_GATE_PATH, subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot } from "@/redline";
import { listGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

type WsCreationDockProps = {
    projectId: string;
    /** 管线选择器已由工作区持有；此处只展示摘要 + 跳分区 */
    pipelineLabel?: string;
    onJumpShots?: () => void;
};

function taskTitle(task: GenerationTask): string {
    const prompt = (task.prompt || "").trim();
    if (prompt) return prompt.length > 42 ? `${prompt.slice(0, 42)}…` : prompt;
    return task.type || task.id;
}

export function WsCreationDock({ projectId, pipelineLabel, onJumpShots }: WsCreationDockProps) {
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((s) => s.updateConfig);
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const [recent, setRecent] = useState<GenerationTask[]>([]);
    const [recentErr, setRecentErr] = useState<string | null>(null);

    const capability = "image" as const;
    const model = config.imageModel || "";

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const tasks = await listGenerationTasks(24, { projectId });
                if (cancelled) return;
                const scoped = (Array.isArray(tasks) ? tasks : []).slice(0, 5);
                setRecent(scoped);
                setRecentErr(null);
            } catch (e) {
                if (!cancelled) setRecentErr(e instanceof Error ? e.message : "近史加载失败");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    const modeLabel = adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL;
    const emptyNsfwHint = useMemo(
        () => (!adultOn ? COPY_NSFW_MODELS_HIDDEN_EMPTY : null),
        [adultOn],
    );

    return (
        <section className="toiv-freezone-panel toiv-ws-creation-dock" data-testid="ws-creation-dock" aria-label="创作坞">
            <ContentModeFallbackTip />
            <div className="toiv-ws-creation-dock-head">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="toiv-ws-creation-dock-title">创作坞</span>
                    <span className="toiv-ws-creation-dock-meta">
                        选模 · 关键参 · 近史同屏 · 内容模式 {modeLabel}
                        {pipelineLabel ? ` · 管线 ${pipelineLabel}` : ""}
                    </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Link to={R18_SETTINGS_GATE_PATH} className="toiv-lumenx-hook" title="切换普通/成人">
                        {modeLabel}
                    </Link>
                    <button type="button" className="toiv-lumenx-hook" onClick={onJumpShots} title="跳到分镜/生成区">
                        <Layers className="size-3" aria-hidden />
                        分镜区
                    </button>
                    <Link to="/create" className="toiv-lumenx-hook" title="打开独立创作台">
                        <Sparkles className="size-3" aria-hidden />
                        创作台
                    </Link>
                </div>
            </div>

            <div className="toiv-ws-creation-dock-row">
                <ModelPicker
                    config={config}
                    value={model}
                    onChange={(next) => updateConfig("imageModel", next)}
                    capability={capability}
                    className="creation-model-picker"
                    placeholder="选择出图模型"
                    variant="creation"
                    fullWidth
                />
            </div>
            {emptyNsfwHint ? (
                <p className="toiv-ws-creation-dock-meta flex flex-wrap items-center gap-2">
                    <NsfwLockBadge />
                    <span>{emptyNsfwHint}</span> ·{" "}
                    <Link to={R18_SETTINGS_GATE_PATH} className="underline underline-offset-2">
                        去设置切换成人
                    </Link>
                </p>
            ) : (
                <p className="toiv-ws-creation-dock-meta">成人模式：NSFW 命名基座/LoRA 可见（含 Mega …-nsfw-…）</p>
            )}

            <div className="flex items-center gap-2">
                <History className="size-3.5 text-[var(--muted-foreground)]" aria-hidden />
                <span className="text-xs font-medium text-foreground">近史</span>
                <Link to="/toiv/tasks" className="ml-auto text-[11px] text-[var(--muted-foreground)] underline-offset-2 hover:underline">
                    任务中心
                </Link>
            </div>
            {recentErr ? <p className="toiv-ws-creation-dock-meta">{recentErr}</p> : null}
            {recent.length ? (
                <ul className="toiv-ws-creation-dock-recent" aria-label="近期生成">
                    {recent.map((task) => {
                        const shot = (task.clientContext?.shotId || "").trim();
                        const q = new URLSearchParams({ section: "shots" });
                        if (shot) q.set("shot", shot);
                        const href = `/create?project=${encodeURIComponent(projectId)}&${q.toString()}`;
                        return (
                            <li key={task.id}>
                                <Link to={href}>
                                    <span className="truncate">{taskTitle(task)}</span>
                                    <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">{task.status}</span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            ) : !recentErr ? (
                <p className="toiv-ws-creation-dock-meta">暂无近史 · 生成后会出现在此</p>
            ) : null}

            {/* LumenX@f2a02e2 MIT：三视图/R2V 锁定入口（角色引用卡内完整工作台） */}
            <div className="toiv-ws-creation-dock-row">
                <Link
                    className="toiv-lumenx-hook is-ready"
                    to={projectId ? `/create?project=${encodeURIComponent(projectId)}&section=assets` : "/create"}
                    title="打开资产：角色三视图 / R2V 锁定"
                >
                    scene_asset · 三视图/R2V 锁定
                </Link>
            </div>
        </section>
    );
}
