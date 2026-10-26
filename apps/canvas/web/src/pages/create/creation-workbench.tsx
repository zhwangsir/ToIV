/**
 * 单一创作工作台：合并 /create 与 /toiv/ws。
 * R3：三栏；R4：剧本解析 + 分镜卡片流；顶栏光幕不挪回侧栏脚。
 * TL R3补+R4：右栏选中扩 420；无挡中栏浮层。
 */
import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";

import { CreationStudioAssetRail } from "@/components/create/creation-studio-asset-rail";
import { CreationStudioInspector } from "@/components/create/creation-studio-inspector";
import { CreationStudioSlotsProvider, useCreationStudioSlots } from "@/components/create/creation-studio-slots";
import { CreationStudioThreePane } from "@/components/create/creation-studio-three-pane";
import { WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";

const CreatePage = lazy(() => import("./index"));
const DramaWorkspacePage = lazy(() => import("@/pages/toiv/drama-workspace"));

function CreationWorkbenchShell() {
    const [searchParams] = useSearchParams();
    const projectId = (searchParams.get("project") || "").trim() || null;
    const section = (searchParams.get("section") || "").trim() || null;
    const slots = useCreationStudioSlots();

    return (
        <div className="toiv-creation-workbench" data-testid="creation-workbench" data-project={projectId || undefined} data-section={section || undefined}>
            <CreationStudioThreePane
                shotSelected={Boolean(slots?.shotSelected)}
                rail={<CreationStudioAssetRail projectId={projectId} section={section} />}
                inspector={<CreationStudioInspector projectId={projectId} section={section} />}
                stage={
                    <Suspense fallback={<WorkspaceRouteLoader />}>
                        {projectId ? <DramaWorkspacePage projectIdOverride={projectId} /> : <CreatePage />}
                    </Suspense>
                }
            />
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
