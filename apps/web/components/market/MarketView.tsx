"use client";

import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
/* rh-seg(荧光 pill 段控)样式在 apps.css 文件级;skills tab 下 AppMarketView 未加载,
   壳层需自行引入(apps- 前缀文件级范式,非 styled-jsx) */
import "@/app/styles/apps.css";

const AppMarketView = lazy(() =>
  import("@/components/apps/AppMarketView").then((m) => ({ default: m.AppMarketView })),
);
const SkillMarketView = lazy(() =>
  import("@/components/skills/SkillMarketView").then((m) => ({ default: m.SkillMarketView })),
);
const EngineStudioView = lazy(() =>
  import("@/components/studio/EngineStudioView").then((m) => ({ default: m.EngineStudioView })),
);
const AudioView = lazy(() =>
  import("@/components/audio/AudioView").then((m) => ({ default: m.AudioView })),
);
const ResourcesView = lazy(() =>
  import("@/components/resources/ResourcesView").then((m) => ({ default: m.ResourcesView })),
);

/** 工具箱一级段:应用/技能内嵌;图片/视频/音频/资源复用既有引擎视图(不重写后端) */
type ToolboxTab = "apps" | "skills" | "image" | "video" | "audio" | "resources";

const TOOLBOX_TABS: readonly { key: ToolboxTab; label: string }[] = [
  { key: "apps", label: "应用" },
  { key: "skills", label: "技能" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
  { key: "audio", label: "音频" },
  { key: "resources", label: "资源" },
];

const TOOLBOX_TAB_SET = new Set<string>(TOOLBOX_TABS.map((t) => t.key));

function readMtab(): ToolboxTab {
  if (typeof window === "undefined") return "apps";
  const raw = new URLSearchParams(window.location.search).get("mtab");
  return raw && TOOLBOX_TAB_SET.has(raw) ? (raw as ToolboxTab) : "apps";
}

export type MarketViewProps = {
  /** 可选:图片/视频/音频/资源也可切到独立父视图(MORE 抽屉仍走独立 view) */
  onNavigate?: (view: string) => void;
  /**
   * navigateExternal=true 时,点击图片/视频/音频/资源走 onNavigate 离开本页;
   * 默认 false=在工具箱内嵌渲染(枢纽体验)。
   */
  navigateExternal?: boolean;
};

/**
 * 工具箱枢纽(2026-10-01 Batch3):原「市场」聚合扩为
 * 应用 | 技能 | 图片 | 视频 | 音频 | 资源。
 * 应用/技能仍内嵌 App/Skill 市场;引擎类复用 EngineStudio/Audio/Resources,
 * 不复制后端。URL 用 mtab= 深链(避免与 ResourcesView 的 tab= 冲突)。
 */
export function MarketView({ onNavigate, navigateExternal = false }: MarketViewProps = {}) {
  const [tab, setTab] = useState<ToolboxTab>("apps");

  useEffect(() => {
    setTab(readMtab());
  }, []);

  const syncMtabUrl = useCallback((next: ToolboxTab) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (next === "apps") params.delete("mtab");
    else params.set("mtab", next);
    // 保 view=market
    if (!params.get("view")) params.set("view", "market");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);

  const selectTab = useCallback(
    (key: ToolboxTab) => {
      const external =
        navigateExternal &&
        onNavigate &&
        (key === "image" || key === "video" || key === "audio" || key === "resources");
      if (external) {
        onNavigate(key);
        return;
      }
      setTab(key);
      syncMtabUrl(key);
    },
    [navigateExternal, onNavigate, syncMtabUrl],
  );

  const activeLabel = TOOLBOX_TABS.find((i) => i.key === tab)?.label ?? "工具箱";

  return (
    <div className="market-view view-shell" data-testid="toolbox-hub">
      <div className="market-mode-row">
        <div className="at-seg rh-seg" role="tablist" aria-label="工具箱">
          {TOOLBOX_TABS.map((i) => (
            <button
              key={i.key}
              type="button"
              role="tab"
              data-testid={`toolbox-tab-${i.key}`}
              aria-selected={tab === i.key}
              className={`at-seg-btn${tab === i.key ? " is-active" : ""}`}
              onClick={() => selectTab(i.key)}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>
      <div className="market-body">
        <ErrorBoundary key={tab} viewName={activeLabel}>
          <Suspense
            fallback={
              <div className="view-fallback" role="status" aria-label="加载中">
                <LoadingBlock variant="line" count={3} />
              </div>
            }
          >
            {tab === "apps" && <AppMarketView runnerBackLabel="返回" />}
            {tab === "skills" && <SkillMarketView />}
            {tab === "image" && <EngineStudioView kind="image" />}
            {tab === "video" && <EngineStudioView kind="video" />}
            {tab === "audio" && <AudioView />}
            {tab === "resources" && <ResourcesView />}
          </Suspense>
        </ErrorBoundary>
      </div>
      <style jsx>{`
        .market-view {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
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
        .market-body :global(.single-view) {
          max-width: none;
          padding-left: 0;
          padding-right: 0;
        }
        /* 内嵌引擎/资源若自带 view-shell,去掉外层重复顶距 */
        .market-body :global(.view-shell) {
          padding-top: 0;
        }
        @media (max-width: 767px) {
          .market-view .at-seg-btn {
            min-height: 44px;
          }
        }
      `}</style>
    </div>
  );
}
