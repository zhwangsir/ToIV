import { Link } from "react-router";
import { useSyncExternalStore } from "react";

import { useCreationStudioSlots } from "@/components/create/creation-studio-slots";
import { CreationPhaseStrip, type CreationPhaseId } from "@/components/toiv/creation-phase-strip";
import { ContentModeFallbackTip } from "@/components/toiv/content-mode-fallback-tip";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL, R18_SETTINGS_GATE_PATH, getR18ModeSnapshot, getServerR18ModeSnapshot, subscribeR18Mode } from "@/redline";

function phaseFromSection(section: string | null, projectId: string | null): CreationPhaseId {
    if (!projectId) return "generate";
    if (section === "script") return "script";
    if (section === "assets") return "asset";
    if (section === "storyboard") return "keyframe";
    return "generate";
}

/**
 * Right Inspector: partitioned attributes — not a settings dump, not R18 master switch.
 * Drama workspace may inject section forms via CreationStudioSlots (R4 migration).
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
    const activePhase = phaseFromSection(section, projectId);

    return (
        <div className="toiv-create-inspector-inner">
            <header className="toiv-create-inspector-head">
                <span className="toiv-create-inspector-title">属性</span>
                <span className="toiv-create-inspector-meta">Inspector</span>
            </header>

            <section className="toiv-create-inspector-section" aria-labelledby="create-insp-phase">
                <h3 id="create-insp-phase" className="toiv-create-inspector-section-title">阶段</h3>
                <CreationPhaseStrip active={activePhase} />
            </section>

            {slots?.inspector ? (
                <section className="toiv-create-inspector-section" aria-label="区段表单" data-testid="creation-studio-inspector-slot">
                    {slots.inspector}
                </section>
            ) : (
                <section className="toiv-create-inspector-section" aria-labelledby="create-insp-params">
                    <h3 id="create-insp-params" className="toiv-create-inspector-section-title">参数分区</h3>
                    <ul className="toiv-create-inspector-list">
                        <li>
                            <span>剧本 / 拆解</span>
                            <em>目标镜数 · SVML 进本栏</em>
                        </li>
                        <li>
                            <span>分镜 / 配景</span>
                            <em>卡片流在中舞台</em>
                        </li>
                        <li>
                            <span>参考 / 定妆</span>
                            <em>左侧资产栏</em>
                        </li>
                    </ul>
                </section>
            )}

            <section className="toiv-create-inspector-section" aria-labelledby="create-insp-mode">
                <h3 id="create-insp-mode" className="toiv-create-inspector-section-title">内容模式</h3>
                <p className="toiv-create-inspector-status">
                    当前：<strong>{adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL}</strong>
                </p>
                <ContentModeFallbackTip />
                <p className="toiv-create-inspector-hint">
                    切换请用<strong>顶栏右侧光幕</strong>「普通｜成人」。
                    <Link to={R18_SETTINGS_GATE_PATH} className="underline underline-offset-2">
                        设置仅说明
                    </Link>
                    ，无主开关。
                </p>
            </section>

            <section className="toiv-create-inspector-section" aria-labelledby="create-insp-gate">
                <h3 id="create-insp-gate" className="toiv-create-inspector-section-title">双闸</h3>
                <p className="toiv-create-inspector-hint">
                    光幕只改模式态与列表过滤；不换底色、不换路由、不拆第二壳。
                </p>
            </section>
        </div>
    );
}
