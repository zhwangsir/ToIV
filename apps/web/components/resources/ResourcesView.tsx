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
 * 直接嵌入既有视图。
 * 页头改用全局统一 .page-header 类(大标题 + 辅助描述 + 右侧 tab 操作区),
 * CornerNav 触发器由壳层 app-main padding-top 垂直让位,页头/内容左右对称。
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
      <header className="page-header resources-head">
        <div className="resources-head-main">
          <h1 className="page-header-title">资源中心</h1>
          <p className="page-header-desc">模型库 · 训练 · 看板 一站式管理工作台</p>
        </div>
        <div className="page-header-actions resources-head-tabs">
          <Tabs items={items} current={tab} onChange={(k) => setTab(k as ResourceTab)} ariaLabel="资源" />
        </div>
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
          /* 覆盖全局 .page-header 的 margin-bottom,页头与下方视图的间距由 body 内 .single-view 自控 */
          margin-bottom: 0;
          padding-top: var(--space-5);
          padding-right: var(--space-8);
          padding-bottom: var(--space-2);
          /* 左右内边距与 .single-view 内容区对齐(壳层 app-main 已垂直让开 CornerNav 触发器,左右对称) */
          padding-left: var(--space-8);
        }
        .resources-head-main {
          min-width: 0;
        }
        .resources-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        @media (max-width: 1023px) {
          .resources-head {
            padding-top: var(--space-4);
            padding-right: var(--space-5);
            padding-left: var(--space-5);
          }
        }
        @media (max-width: 767px) {
          .resources-head {
            padding-top: var(--space-3);
            padding-right: var(--space-4);
            padding-left: var(--space-4);
          }
          /* 移动端触控目标 ≥44px */
          .resources-head :global(.ui-tab) {
            min-height: 44px;
          }
        }
      `}</style>
    </div>
  );
}
