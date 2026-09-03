"use client";

import { lazy, Suspense, useState } from "react";

import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { featuredAppIdsForKind, type AppOutputKind } from "@/lib/apps";
import "@/app/styles/apps.css";

const AppMarketView = lazy(() =>
  import("@/components/apps/AppMarketView").then((m) => ({ default: m.AppMarketView })),
);
const GenerateView = lazy(() =>
  import("@/components/generate/GenerateView").then((m) => ({ default: m.GenerateView })),
);

type CreateTab = "apps" | "engine";

/**
 * 图片/视频创作壳(2026-09-03):默认「应用」目录(按 output_kind 过滤,点开 AppRunnerView),
 * 「高级引擎」仍挂既有 GenerateView。RunningHub 式选应用,不先选引擎。
 */
export function KindCreateView({ kind }: { kind: AppOutputKind }) {
  const [tab, setTab] = useState<CreateTab>("apps");

  const items: { key: CreateTab; label: string }[] = [
    { key: "apps", label: "应用" },
    { key: "engine", label: "高级引擎" },
  ];

  return (
    <div className="apps-kind-create">
      <div className="apps-kind-mode-row">
        <div className="at-seg" role="tablist" aria-label={kind === "video" ? "视频" : "图片"}>
          {items.map((i) => (
            <button
              key={i.key}
              type="button"
              role="tab"
              aria-selected={tab === i.key}
              className={`at-seg-btn${tab === i.key ? " is-active" : ""}`}
              onClick={() => setTab(i.key)}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>
      <div className={`apps-kind-body${tab === "engine" ? " is-engine" : ""}`}>
        <ErrorBoundary key={tab} viewName={items.find((i) => i.key === tab)?.label ?? "创作"}>
          <Suspense
            fallback={
              <div className="view-fallback" role="status" aria-label="加载中">
                <LoadingBlock variant="line" count={3} />
              </div>
            }
          >
            {tab === "apps" && (
              <AppMarketView
                outputKind={kind}
                featuredIds={featuredAppIdsForKind(kind)}
                runnerBackLabel="返回应用"
              />
            )}
            {tab === "engine" && <GenerateView lockedKind={kind} />}
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
