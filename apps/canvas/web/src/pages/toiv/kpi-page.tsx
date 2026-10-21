/**
 * F3：北向 KPI 看板页（COMPETITIVE L6）。
 */
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { KpiNorthboundPanel } from "@/components/toiv/kpi-northbound-panel";
import { ToolButton } from "@/components/ui/base/buttons";

export default function ToivKpiPage() {
    return (
        <WorkspacePage fluid className="toiv-kpi-page">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
                <header className="flex items-center justify-between gap-3">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-xl font-semibold leading-7 text-foreground">北向学习看板</h1>
                        <p className="text-xs leading-5 text-muted-foreground">
                            首集成片率 · 不进自由画布完成率 · 一致性返工 · 本地队列 P50。无样本显示「暂无数据」，不造假。
                        </p>
                    </div>
                    <Link to="/toiv/drama">
                        <ToolButton variant="ghost" icon={<ArrowLeft />} label="回短剧" />
                    </Link>
                </header>
                <KpiNorthboundPanel days={30} compact={false} />
                <p className="text-xs text-[var(--muted-foreground)]">
                    事件来自：合成成功/失败（服务端）、短剧工作区 / 自由画布触达、一致性返工、队列等待采样。详见 COMPETITIVE §12 L6。
                </p>
            </div>
        </WorkspacePage>
    );
}
