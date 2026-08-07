"use client";

import { lazy, Suspense, useState } from "react";

import { Tabs } from "@/components/ui/Tabs";

const ModelsView = lazy(() =>
  import("@/components/models/ModelsView").then((m) => ({ default: m.ModelsView })),
);
const TrainView = lazy(() =>
  import("@/components/train/TrainView").then((m) => ({ default: m.TrainView })),
);
const BacklotView = lazy(() =>
  import("@/components/backlot/BacklotView").then((m) => ({ default: m.BacklotView })),
);
const AdminView = lazy(() =>
  import("@/components/admin/AdminView").then((m) => ({ default: m.AdminView })),
);

type ResourceTab = "models" | "train" | "backlot" | "admin";

interface ResourcesViewProps {
  /** 管理员可见「管理」tab */
  showAdmin?: boolean;
}

/**
 * 资源聚合页(W0):模型库 / 训练 / 看板 / 管理 四个二级 tab,
 * 直接嵌入既有视图,内部换皮留待 W3。
 */
export function ResourcesView({ showAdmin = false }: ResourcesViewProps) {
  const [tab, setTab] = useState<ResourceTab>("models");

  const items = [
    { key: "models", label: "模型库" },
    { key: "train", label: "训练" },
    { key: "backlot", label: "看板" },
    ...(showAdmin ? [{ key: "admin", label: "管理" }] : []),
  ];

  return (
    <div className="resources-view">
      <header className="resources-head">
        <Tabs items={items} current={tab} onChange={(k) => setTab(k as ResourceTab)} ariaLabel="资源" />
      </header>
      <div className="resources-body">
        <Suspense
          fallback={
            <div className="view-fallback" role="status" aria-label="加载中">
              <div className="splash-orb" aria-hidden="true" />
            </div>
          }
        >
          {tab === "models" && <ModelsView />}
          {tab === "train" && <TrainView />}
          {tab === "backlot" && <BacklotView />}
          {tab === "admin" && showAdmin && <AdminView />}
        </Suspense>
      </div>
      <style jsx>{`
        .resources-view {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        .resources-head {
          flex-shrink: 0;
          padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + var(--nav-safe-left)); /* 桌面端让开 CornerNav 触发器 */
          border-bottom: 1px solid var(--border-subtle);
        }
        .resources-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
        }
      `}</style>
    </div>
  );
}
