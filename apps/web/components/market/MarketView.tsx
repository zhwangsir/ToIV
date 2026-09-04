"use client";

import { lazy, Suspense, useState } from "react";

import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { LoadingBlock } from "@/components/ui/LoadingBlock";

const AppMarketView = lazy(() =>
  import("@/components/apps/AppMarketView").then((m) => ({ default: m.AppMarketView })),
);
const SkillMarketView = lazy(() =>
  import("@/components/skills/SkillMarketView").then((m) => ({ default: m.SkillMarketView })),
);

type MarketTab = "apps" | "skills";

/**
 * 市场聚合页(2026-08-31 前端精简):「Skill 市场」与「应用市场」两个一级菜单项
 * 结构/功能高度同构(三区卡片 + 搜索 + chips 过滤),合并为单一「市场」入口,
 * 页头 at-seg 段控切换;旧 view key skills/apps 经 page.tsx LEGACY_VIEW_REDIRECTS
 * 跳本页(不 404)。
 *
 * 页头说明(2026-09-02 W3):聚合层 PageHeader 已移除,段控独立窄行;
 * 内嵌视图(应用/技能)检索工具栏即首行;.single-view 去嵌套——
 * 版心/左右内边距由本页 .view-shell 统一供给;ErrorBoundary+Suspense 内层包裹。
 */
export function MarketView() {
  const [tab, setTab] = useState<MarketTab>("apps");

  const items = [
    { key: "apps", label: "应用" },
    { key: "skills", label: "技能" },
  ];

  return (
    <div className="market-view view-shell">
      {/* 页头移除(2026-09-02 W3):段控独立窄行,与音频页 audio-mode-row 同款 */}
      <div className="market-mode-row">
        <div className="at-seg" role="tablist" aria-label="市场">
          {items.map((i) => (
            <button
              key={i.key}
              type="button"
              role="tab"
              aria-selected={tab === i.key}
              className={`at-seg-btn${tab === i.key ? " is-active" : ""}`}
              onClick={() => setTab(i.key as MarketTab)}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>
      <div className="market-body">
        {/* 内层错误边界(UI-B):子视图渲染/chunk 加载异常时只降级内容区,
            页头 tab 条保持可用,切换 tab(key 变更)即自动复位边界 */}
        <ErrorBoundary key={tab} viewName={items.find((i) => i.key === tab)?.label ?? "市场"}>
          <Suspense
            fallback={
              <div className="view-fallback" role="status" aria-label="加载中">
                <LoadingBlock variant="line" count={3} />
              </div>
            }
          >
            {tab === "apps" && <AppMarketView />}
            {tab === "skills" && <SkillMarketView />}
          </Suspense>
        </ErrorBoundary>
      </div>
      <style jsx>{`
        .market-view {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        /* 段控窄行(页头已移除):首屏全给内容;
           与内容区间距走 --layout-toolbar-gap 版型档(2026-09-04 美化 W4) */
        .market-mode-row {
          flex-shrink: 0;
          display: flex;
          padding: 0 0 var(--layout-toolbar-gap);
        }
        .market-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        /* P2-3 去嵌套:内嵌视图的 .single-view 版心/左右内边距失效(本页 .view-shell 已供) */
        .market-body :global(.single-view) {
          max-width: none;
          padding-left: 0;
          padding-right: 0;
        }
        @media (max-width: 767px) {
          /* 移动端触控目标 ≥44px */
          .market-view .at-seg-btn {
            min-height: 44px;
          }
        }
      `}</style>
    </div>
  );
}
