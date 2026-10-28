/**
 * 单一创作工作台：合并 /create 与 /toiv/ws。
 * R3：三栏；R4：剧本解析 + 分镜卡片流；顶栏光幕不挪回侧栏脚。
 * TL R3补+R4：右栏选中扩 420；无挡中栏浮层。
 * R8：预览时间线全宽贴底（--toiv-timeline-*）；320/420 只挤中列。
 * R9：空态/骨架/微动效（--toiv-empty-* / --toiv-skeleton-* / --toiv-motion-*）。
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { CreationStudioAssetRail } from "@/components/create/creation-studio-asset-rail";
import { CreationStudioInspector } from "@/components/create/creation-studio-inspector";
import { CreationStudioSlotsProvider, useCreationStudioSlots } from "@/components/create/creation-studio-slots";
import { CreationStudioPreviewTimeline } from "@/components/create/creation-studio-preview-timeline";
import { CreationStudioThreePane } from "@/components/create/creation-studio-three-pane";
import { ProjectBiblePanel } from "@/components/toiv/project-bible-panel";
import { ToivSkeletonPane } from "@/components/toiv/toiv-skeleton";

const CreatePage = lazy(() => import("./index"));
const DramaWorkspacePage = lazy(() => import("@/pages/toiv/drama-workspace"));
const LegacyAgentPage = lazy(() => import("@/pages/toiv/agent-page"));

function CreationWorkbenchShell() {
    const [searchParams] = useSearchParams();
    const projectId = (searchParams.get("project") || "").trim() || null;
    const section = (searchParams.get("section") || "").trim() || null;
    const legacyAgentView = searchParams.get("view") === "agent";
    const slots = useCreationStudioSlots();
    const [inspectorOverride, setInspectorOverride] = useState<boolean | null>(null);
    const inspectorVisible = inspectorOverride ?? Boolean(slots?.inspector || slots?.shotSelected);
    useEffect(() => {
        if (slots?.shotSelected) setInspectorOverride(null);
    }, [slots?.shotSelected]);
    // C1c:阶段阻断定位(stageFocus)→ 明确打开右栏 Inspector,开合职权留在 workbench 壳
    useEffect(() => {
        if (slots?.stageFocus) setInspectorOverride(true);
    }, [slots?.stageFocus]);

    // BF0: /create 无 project → BeefTV composer-first（不套三栏密台）；?project= 短剧三栏保留
    if (!projectId && section !== "bible" && !legacyAgentView) {
        return (
            <div className="toiv-creation-workbench is-composer-first" data-testid="creation-workbench" data-surface="beeftv-create">
                <Suspense fallback={<ToivSkeletonPane />}>
                    <CreatePage />
                </Suspense>
            </div>
        );
    }

    return (
        <div className="toiv-creation-workbench" data-testid="creation-workbench" data-surface="beeftv-drama" data-project={projectId || undefined} data-section={section || undefined}>
            <CreationStudioThreePane
                shotSelected={Boolean(slots?.shotSelected)}
                inspectorVisible={inspectorVisible}
                onToggleInspector={() => setInspectorOverride(!inspectorVisible)}
                rail={<CreationStudioAssetRail projectId={projectId} section={section} />}
                inspector={<CreationStudioInspector projectId={projectId} section={section} />}
                stage={
                    <Suspense fallback={<ToivSkeletonPane />}>
                        {section === "bible" ? (
                            <ProjectBiblePanel variant="page" />
                        ) : legacyAgentView ? (
                            <LegacyAgentPage />
                        ) : (
                            <DramaWorkspacePage projectIdOverride={projectId!} />
                        )}
                    </Suspense>
                }
            />
            {/* R8: full-width bottom dock — Inspector 320/420 only squeezes center column */}
            <CreationStudioPreviewTimeline projectId={projectId} />
        </div>
    );
}

export default function CreationWorkbenchPage() {
    return (
        <CreationStudioSlotsProvider>
            <CreationWorkbenchShell />
        </CreationStudioSlotsProvider>
    );
}
