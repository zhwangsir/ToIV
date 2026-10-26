/**
 * 单一创作工作台：合并 /create 与 /toiv/ws。
 * - 无 project → 自由创作（原 CreatePage）
 * - 有 ?project= → 短剧六段工作区（原 DramaWorkspace）
 * 侧栏「创作」置顶进入本页；新建短剧为台内动作。
 */
import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";

import { CreationProjectSwitcher } from "@/components/toiv/creation-project-switcher";
import { ContentModeFallbackTip } from "@/components/toiv/content-mode-fallback-tip";
import { WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";

const CreatePage = lazy(() => import("./index"));
const DramaWorkspacePage = lazy(() => import("@/pages/toiv/drama-workspace"));

export default function CreationWorkbenchPage() {
    const [searchParams] = useSearchParams();
    const projectId = (searchParams.get("project") || "").trim();

    return (
        <div className="toiv-creation-workbench" data-testid="creation-workbench" data-project={projectId || undefined}>
            <div className="toiv-creation-workbench-chrome">
                <CreationProjectSwitcher projectId={projectId || null} />
                <ContentModeFallbackTip />
            </div>
            <Suspense fallback={<WorkspaceRouteLoader />}>
                {projectId ? <DramaWorkspacePage projectIdOverride={projectId} /> : <CreatePage />}
            </Suspense>
        </div>
    );
}
