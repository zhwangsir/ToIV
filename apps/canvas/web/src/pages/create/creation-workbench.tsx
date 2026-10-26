/**
 * 单一创作工作台：合并 /create 与 /toiv/ws。
 * R3：三栏（资产栏 ≈240｜主舞台｜Inspector）；顶栏光幕不挪回侧栏脚。
 */
import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";

import { CreationStudioAssetRail } from "@/components/create/creation-studio-asset-rail";
import { CreationStudioInspector } from "@/components/create/creation-studio-inspector";
import { CreationStudioThreePane } from "@/components/create/creation-studio-three-pane";
import { WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";

const CreatePage = lazy(() => import("./index"));
const DramaWorkspacePage = lazy(() => import("@/pages/toiv/drama-workspace"));

export default function CreationWorkbenchPage() {
    const [searchParams] = useSearchParams();
    const projectId = (searchParams.get("project") || "").trim() || null;

    return (
        <div className="toiv-creation-workbench" data-testid="creation-workbench" data-project={projectId || undefined}>
            <CreationStudioThreePane
                rail={<CreationStudioAssetRail projectId={projectId} />}
                inspector={<CreationStudioInspector projectId={projectId} />}
                stage={
                    <Suspense fallback={<WorkspaceRouteLoader />}>
                        {projectId ? <DramaWorkspacePage projectIdOverride={projectId} /> : <CreatePage />}
                    </Suspense>
                }
            />
        </div>
    );
}
