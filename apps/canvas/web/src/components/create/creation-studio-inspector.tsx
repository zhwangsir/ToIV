import { Link } from "react-router";
import { useSyncExternalStore } from "react";

import { CreationPhaseStrip } from "@/components/toiv/creation-phase-strip";
import { ContentModeFallbackTip } from "@/components/toiv/content-mode-fallback-tip";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL, R18_SETTINGS_GATE_PATH, getR18ModeSnapshot, getServerR18ModeSnapshot, subscribeR18Mode } from "@/redline";

/**
 * Right Inspector: partitioned attributes — not a settings dump, not R18 master switch.
 * Content mode is status-only; switch lives on topbar LightCurtainPaddle.
 */
export function CreationStudioInspector({ projectId }: { projectId: string | null }) {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);

    return (
        <div className="toiv-create-inspector-inner">
            <header className="toiv-create-inspector-head">
                <span className="toiv-create-inspector-title">属性</span>
                <span className="toiv-create-inspector-meta">Inspector</span>
            </header>

            <section className="toiv-create-inspector-section" aria-labelledby="create-insp-phase">
                <h3 id="create-insp-phase" className="toiv-create-inspector-section-title">阶段</h3>
                <CreationPhaseStrip active={projectId ? "asset" : "generate"} />
            </section>

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

            <section className="toiv-create-inspector-section" aria-labelledby="create-insp-params">
                <h3 id="create-insp-params" className="toiv-create-inspector-section-title">参数分区</h3>
                <ul className="toiv-create-inspector-list">
                    <li>
                        <span>模型 / 管线</span>
                        <em>舞台内选模 · 勿堆表单墙</em>
                    </li>
                    <li>
                        <span>画幅 / 时长</span>
                        <em>随创作模式（文图视频）</em>
                    </li>
                    <li>
                        <span>参考 / 定妆</span>
                        <em>左侧资产栏进入</em>
                    </li>
                    <li>
                        <span>输出 / 导出</span>
                        <em>成片段与任务中心</em>
                    </li>
                </ul>
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
