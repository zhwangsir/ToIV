import { Link, useNavigate, useSearchParams } from "react-router";
import { useSyncExternalStore } from "react";

import { useCreationStudioSlots } from "@/components/create/creation-studio-slots";
import { CreationPhaseStrip, type CreationPhaseId } from "@/components/toiv/creation-phase-strip";
import { CreationStageTrack } from "@/components/toiv/creation-stage-track";
import { ContentModeFallbackTip } from "@/components/toiv/content-mode-fallback-tip";
import { hasStageStates, parseStudioStage } from "@/lib/studio-stage-progress";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL, R18_SETTINGS_GATE_PATH, getR18ModeSnapshot, getServerR18ModeSnapshot, subscribeR18Mode } from "@/redline";

function phaseFromSection(section: string | null, projectId: string | null): CreationPhaseId {
    if (!projectId) return "generate";
    if (section === "script") return "script";
    if (section === "assets") return "asset";
    if (section === "storyboard") return "keyframe";
    return "generate";
}

/**
 * Right Inspector (B2 BeefTV dense): partitioned attributes — single primary CTA weight;
 * not a settings dump, not R18 master switch.
 * Drama workspace may inject section forms via CreationStudioSlots (R4 migration).
 * C1c:六阶段轨道从 slots 消费 drama-workspace 注册的项目真源(detail + load),
 * 成功操作只经 slots.reloadProject 刷新;无项目/旧服务端(六段不全)保留原四阶段。
 */
export function CreationStudioInspector({
    projectId,
    section = null,
}: {
    projectId: string | null;
    section?: string | null;
}) {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const slots = useCreationStudioSlots();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const activePhase = phaseFromSection(section, projectId);
    const requestedStage = parseStudioStage(searchParams.get("stage"));
    const slotFocusStage = slots?.stageFocus?.pid === projectId ? slots.stageFocus.stage : undefined;
    // C1c:只消费 slots 真源;pid 不匹配(项目切换中)视为无 detail,回退四阶段
    const detail = slots?.projectDetail?.id === projectId ? slots.projectDetail : null;
    const showStageTrack = Boolean(projectId && detail && hasStageStates(detail));

    const goSection = (key: string) => {
        if (!projectId) return;
        const next = new URLSearchParams(searchParams);
        next.set("project", projectId);
        next.set("section", key);
        navigate(`/create?${next.toString()}`, { replace: true });
    };

    return (
        <div className="toiv-create-inspector-inner">
            <header className="toiv-create-inspector-head">
                <span className="toiv-create-inspector-title">属性</span>
            </header>

            <section className="toiv-create-inspector-section" aria-labelledby="create-insp-phase">
                <h3 id="create-insp-phase" className="toiv-create-inspector-section-title">阶段</h3>
                {showStageTrack ? (
                    <CreationStageTrack
                        detail={detail}
                        section={section}
                        onNavigate={goSection}
                        onReload={slots?.reloadProject}
                        focusStage={slotFocusStage ?? requestedStage ?? undefined}
                    />
                ) : (
                    <CreationPhaseStrip active={activePhase} />
                )}
            </section>

            {slots?.inspector ? (
                <section className="toiv-create-inspector-section" aria-label="区段表单" data-testid="creation-studio-inspector-slot">
                    {slots.inspector}
                </section>
            ) : (
                <section className="toiv-create-inspector-section" aria-labelledby="create-insp-params">
                    <h3 id="create-insp-params" className="toiv-create-inspector-section-title">区段</h3>
                    <ul className="toiv-create-inspector-list">
                        <li><span>剧本</span></li>
                        <li><span>分镜</span></li>
                        <li><span>参考</span></li>
                    </ul>
                </section>
            )}

            <section className="toiv-create-inspector-section" aria-labelledby="create-insp-mode">
                <h3 id="create-insp-mode" className="toiv-create-inspector-section-title">内容模式</h3>
                <p className="toiv-create-inspector-status">
                    当前：<strong>{adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL}</strong>
                </p>
                <ContentModeFallbackTip />
                {searchParams.get("debug") === "1" ? (
                    <p className="toiv-create-inspector-hint">
                        <Link to={R18_SETTINGS_GATE_PATH} className="underline underline-offset-2">
                            模式说明
                        </Link>
                    </p>
                ) : null}
            </section>
        </div>
    );
}
