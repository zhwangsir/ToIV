"use client";

import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { PageHeader } from "@/components/ui/PageHeader";

const ModelsView = lazy(() =>
  import("@/components/models/ModelsView").then((m) => ({ default: m.ModelsView })),
);
const TrainView = lazy(() =>
  import("@/components/train/TrainView").then((m) => ({ default: m.TrainView })),
);
const BacklotView = lazy(() =>
  import("@/components/backlot/BacklotView").then((m) => ({ default: m.BacklotView })),
);

type ResourceTab = "models" | "train" | "backlot";

const RESOURCE_TABS = new Set<string>(["models", "train", "backlot"]);

/**
 * 资源聚合页(W0):模型库 / 训练 / 看板 三个二级 tab,直接嵌入既有视图。
 * 2026-08-31 精简:「管理」tab 移除(管理面板已有管理员专属导航入口,双入口去重)。
 * 2026-08-31 W1:支持 ?tab= 直达(models/train/backlot 旧视图 key 重定向进来时携带)。
 * Film Atelier(2026-08-15):
 * - 根容器接入 .view-shell 版心(原 scoped .resources-head  padding 因子组件边界失效,
 *   页头贴左缘 = P0-1;此处页头样式一律走 :global 修正);
 * - tab 换墨丸段控 .at-seg(P1-1);
 * - P2-3 去双重容器:内嵌视图根 .single-view 的版心/左右内边距在本页失效,
 *   由 .view-shell 统一供节奏,不再包第二层容器。
 */
export function ResourcesView({ onCreateProject }: { onCreateProject?: () => void }) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<ResourceTab>(() => {
    const raw = searchParams.get("tab");
    return raw && RESOURCE_TABS.has(raw) ? (raw as ResourceTab) : "models";
  });

  const items = [
    { key: "models", label: "模型库" },
    { key: "train", label: "训练" },
    { key: "backlot", label: "看板" },
  ];

  return (
    <div className="resources-view view-shell">
      {/* 页头:UI-A PageHeader;resources-head 经 className 透传,样式走 :global(见下) */}
      <PageHeader
        className="resources-head"
        title="资源中心"
        desc="模型库 · 训练 · 看板 一站式管理工作台"
        actions={
          <div className="at-seg" role="tablist" aria-label="资源">
            {items.map((i) => (
              <button
                key={i.key}
                type="button"
                role="tab"
                aria-selected={tab === i.key}
                className={`at-seg-btn${tab === i.key ? " is-active" : ""}`}
                onClick={() => setTab(i.key as ResourceTab)}
              >
                {i.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="resources-body">
        {/* 内层错误边界(UI-B):子视图渲染/chunk 加载异常时只降级内容区,
            页头 tab 条保持可用,切换 tab(key 变更)即自动复位边界 */}
        <ErrorBoundary key={tab} viewName={items.find((i) => i.key === tab)?.label ?? "资源"}>
          <Suspense
            fallback={
              <div className="view-fallback" role="status" aria-label="加载中">
                <LoadingBlock variant="line" count={3} />
              </div>
            }
          >
            {tab === "models" && <ModelsView />}
            {tab === "train" && <TrainView />}
            {tab === "backlot" && <BacklotView onCreateProject={onCreateProject} />}
          </Suspense>
        </ErrorBoundary>
      </div>
      <style jsx>{`
        .resources-view {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        /* 页头元素在 PageHeader 组件内渲染,scoped 选择器跨不过组件边界,须 :global */
        .resources-view :global(.resources-head) {
          flex-shrink: 0;
        }
        .resources-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        /* P2-3 去嵌套:内嵌视图的 .single-view 版心/左右内边距失效(本页 .view-shell 已供) */
        .resources-body :global(.single-view) {
          max-width: none;
          padding-left: 0;
          padding-right: 0;
        }
        /* 双页头修复(2026-08-16 审计 P1):内嵌视图(ModelsView 等)的完整页头
           与「资源中心」页头堆叠——降级为分区小节:标题收到 section 档
           (无衬线/15px/600)、去底部分隔线与呼吸,视觉层级 = 页头 → 小节;
           页头操作槽(段控 tab)保留可用 */
        .resources-body :global(.page-header) {
          padding-bottom: 0;
          margin-bottom: var(--space-4);
          border-bottom: none;
        }
        .resources-body :global(.page-header-title) {
          font-family: var(--font-sans);
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          letter-spacing: -0.01em;
          line-height: var(--leading-base);
        }
        @media (max-width: 767px) {
          /* 移动端触控目标 ≥44px */
          .resources-view .at-seg-btn {
            min-height: 44px;
          }
        }
      `}</style>
    </div>
  );
}
