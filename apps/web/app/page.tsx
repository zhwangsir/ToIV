"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { LandingPage } from "@/components/landing/LandingPage";
import { DynamicIsland, type DynamicIslandView } from "@/components/nav/DynamicIsland";
import { Topbar } from "@/components/nav/Topbar";
import { BottomNav, type BottomNavItem } from "@/components/nav/BottomNav";
import { fetchMe, getToken, setToken, testLogin } from "@/lib/api";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Icon } from "@/components/ui/Icon";

type AuthState = "loading" | "in" | "out";

type View =
  | "assistant"
  | "avatartalk"
  | "create"
  | "video"
  | "canvas"
  | "dramaStudio"
  | "dub"
  | "train"
  | "library"
  | "backlot"
  | "models"
  | "admin";

// ── 视图懒加载:chunk 按需拉取;菜单展开/悬停期间并行预热,消除切换白屏等待 ──
const viewImporters = {
  assistant: () => import("@/components/assistant/AssistantView"),
  avatartalk: () => import("@/components/avatartalk/AvatarTalkView"),
  create: () => import("@/components/create/CreateView"),
  video: () => import("@/components/create/VideoView"),
  canvas: () => import("@/components/canvas/CanvasView"),
  dramaStudio: () => import("@/components/drama-studio/DramaStudioView"),
  dub: () => import("@/components/dub/DubView"),
  train: () => import("@/components/train/TrainView"),
  library: () => import("@/components/library/LibraryView"),
  backlot: () => import("@/components/backlot/BacklotView"),
  models: () => import("@/components/models/ModelsView"),
  admin: () => import("@/components/admin/AdminView"),
} as const;

/** 预热目标视图 chunk。webpack 模块缓存去重,重复/并发调用零额外开销。 */
function preloadView(key: View) {
  viewImporters[key]().catch(() => {
    /* 预热失败不阻塞:点击时 lazy 会重新发起加载 */
  });
}

const AssistantView = lazy(() =>
  viewImporters.assistant().then((m) => ({ default: m.AssistantView })),
);
const AvatarTalkView = lazy(() =>
  viewImporters.avatartalk().then((m) => ({ default: m.AvatarTalkView })),
);
const CreateView = lazy(() =>
  viewImporters.create().then((m) => ({ default: m.CreateView })),
);
const VideoView = lazy(() =>
  viewImporters.video().then((m) => ({ default: m.VideoView })),
);
const CanvasView = lazy(() =>
  viewImporters.canvas().then((m) => ({ default: m.CanvasView })),
);
const DramaStudioView = lazy(() =>
  viewImporters.dramaStudio().then((m) => ({ default: m.DramaStudioView })),
);
const DubView = lazy(() =>
  viewImporters.dub().then((m) => ({ default: m.DubView })),
);
const TrainView = lazy(() =>
  viewImporters.train().then((m) => ({ default: m.TrainView })),
);
const LibraryView = lazy(() =>
  viewImporters.library().then((m) => ({ default: m.LibraryView })),
);
const BacklotView = lazy(() =>
  viewImporters.backlot().then((m) => ({ default: m.BacklotView })),
);
const ModelsView = lazy(() =>
  viewImporters.models().then((m) => ({ default: m.ModelsView })),
);
const AdminView = lazy(() =>
  viewImporters.admin().then((m) => ({ default: m.AdminView })),
);

/** 视图切换加载占位:与 splash 同源的呼吸圆点,视觉一致且极简。 */
function ViewFallback({ label }: { label: string }) {
  return (
    <div className="view-fallback" role="status" aria-label={`${label}加载中`}>
      <div className="splash-orb" aria-hidden="true" />
    </div>
  );
}

const VALID_VIEWS = new Set<View>([
  "assistant",
  "avatartalk",
  "create",
  "video",
  "canvas",
  "dramaStudio",
  "dub",
  "train",
  "library",
  "backlot",
  "models",
  "admin",
]);

const VIEW_META: Record<View, { label: string }> = {
  assistant: { label: "AI 助手" },
  avatartalk: { label: "数字人" },
  create:    { label: "创作" },
  video:     { label: "视频" },
  canvas:    { label: "画布" },
  dramaStudio: { label: "短剧" },
  dub:       { label: "译制" },
  train:     { label: "训练" },
  library:   { label: "作品库" },
  backlot:   { label: "看板" },
  models:    { label: "模型" },
  admin:     { label: "管理" },
};

const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  { key: "assistant", label: "对话", icon: "chat" },
  { key: "create", label: "创作", icon: "sparkles" },
  { key: "dramaStudio", label: "新建", icon: "plus", isCta: true },
  { key: "library", label: "作品", icon: "library" },
  { key: "canvas", label: "画布", icon: "workflow" },
];

export const dynamic = "force-dynamic";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const isPortraitMobile = width < 768;
      const isLandscapeMobile = width < 900 && height < 500;
      setIsMobile(isPortraitMobile || isLandscapeMobile);
    };
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);
  return isMobile;
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="splash">
          <div className="splash-orb" aria-hidden="true" />
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const [auth, setAuth] = useState<AuthState>("loading");
  const [account, setAccount] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => {
    const v = searchParams.get("view");
    return v && VALID_VIEWS.has(v as View) ? (v as View) : "assistant";
  });
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  useEffect(() => {
    const v = searchParams.get("view");
    if (v && VALID_VIEWS.has(v as View) && v !== view) {
      setView(v as View);
    }
  }, [searchParams, view]);

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const t = params.get("t");
      const testkey = params.get("testkey");
      if (t || testkey) {
        try {
          if (t) setToken(t);
          else if (testkey) setToken((await testLogin(testkey)).token);
        } catch {
          /* 通道失败落回登录 */
        }
        params.delete("t");
        params.delete("testkey");
        const qs = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
      }

      if (!getToken()) {
        setAuth("out");
        return;
      }
      fetchMe()
        .then((me) => {
          setAccount(me.user.email);
          setAuth("in");
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          const isAuth = msg.includes("会话已过期") || msg.includes("401");
          if (isAuth) {
            setToken(null);
          }
          setAuth("out");
        });
    })();
  }, []);

  const onLogout = useCallback(() => {
    setToken(null);
    setAccount(null);
    setAuth("out");
  }, []);

  const changeView = useCallback(
    (next: View) => {
      preloadView(next); // 兜底:未预热目标在点击瞬间立即发起加载
      setView(next);
      router.replace(`/?view=${next}`);
    },
    [router],
  );

  // DI 菜单展开动画期间:并行预热主组视图 chunk(动画与加载并行化)
  const handleMenuOpen = useCallback(() => {
    (["assistant", "avatartalk", "canvas"] as View[]).forEach(preloadView);
  }, []);

  // 菜单项悬停/聚焦:按操作意向精确预热目标视图
  const handleViewIntent = useCallback((key: string) => {
    if (VALID_VIEWS.has(key as View)) preloadView(key as View);
  }, []);

  const isAdmin = account === "admin";

  const diViews: DynamicIslandView[] = useMemo(() => {
    return [
      { key: "assistant", label: "AI 助手", icon: "chat", group: "main" },
      { key: "avatartalk", label: "数字人", icon: "user", group: "main" },
      { key: "canvas", label: "画布", icon: "canvas", group: "main" },
      { key: "create", label: "图像创作", icon: "create", group: "tools" },
      { key: "video", label: "视频生成", icon: "video", group: "tools" },
      { key: "dramaStudio", label: "短剧工作室", icon: "drama", group: "tools" },
      { key: "dub", label: "译制配音", icon: "dub", group: "tools" },
      { key: "library", label: "作品库", icon: "library", group: "resources" },
      { key: "models", label: "模型库", icon: "models", group: "resources" },
      ...(isAdmin ? [{ key: "admin", label: "管理", icon: "admin" as const, group: "resources" as const }] : []),
    ];
  }, [isAdmin]);

  const meta = VIEW_META[view];
  const showRightPanelToggle = view === "create" || view === "video";

  if (auth === "loading") {
    return (
      <div className="splash">
        <div className="splash-orb" aria-hidden="true" />
      </div>
    );
  }

  if (auth === "out") {
    return <LandingPage />;
  }

  if (view === "avatartalk") {
    return (
      <div className="app-shell avatartalk-shell">
        <DynamicIsland
          views={diViews}
          current={view}
          onSelect={(key) => changeView(key as View)}
          onMenuOpen={handleMenuOpen}
          onViewIntent={handleViewIntent}
        />
        <main className="app-main avatartalk-main">
          <ErrorBoundary viewName="数字人对话">
            <Suspense fallback={<ViewFallback label={VIEW_META.avatartalk.label} />}>
              <AvatarTalkView />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    );
  }

  const shellClasses = [
    "app-shell",
    "di-nav",
    rightPanelOpen && showRightPanelToggle ? "has-right-panel" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClasses}>
      <DynamicIsland
        views={diViews}
        current={view}
        onSelect={(key) => changeView(key as View)}
        onMenuOpen={handleMenuOpen}
        onViewIntent={handleViewIntent}
      />

      <Topbar
        account={account ?? undefined}
        onLogout={onLogout}
        onRightPanelToggle={showRightPanelToggle ? () => setRightPanelOpen((v) => !v) : undefined}
        rightPanelOpen={rightPanelOpen}
      />

      <main id="main" className="app-main">
        <div className="view-root">
          <ErrorBoundary key={view} viewName={meta.label}>
            <Suspense fallback={<ViewFallback label={meta.label} />}>
              {view === "assistant" && <AssistantView />}
              {view === "create" && <CreateView />}
              {view === "video" && <VideoView />}
              {view === "canvas" && <CanvasView />}
              {view === "dramaStudio" && (
                isMobile ? (
                  <div className="single-view">
                    <div className="empty-state">
                      <div className="empty-state-icon">
                        <Icon name="drama" size={48} />
                      </div>
                      <h3 className="empty-state-title">工作室</h3>
                      <p className="empty-state-desc">
                        工作室建议在桌面端或平板横屏模式下使用，以获得最佳体验。
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => changeView("assistant")}
                      >
                        返回 AI 助手
                      </button>
                    </div>
                  </div>
                ) : (
                  <DramaStudioView
                    account={account ?? undefined}
                    onLogout={onLogout}
                    onNavigate={(next) => changeView(next as View)}
                  />
                )
              )}
              {view === "dub" && <DubView />}
              {view === "train" && <TrainView />}
              {view === "library" && <LibraryView />}
              {view === "backlot" && <BacklotView />}
              {view === "models" && <ModelsView />}
              {view === "admin" && <AdminView />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      {showRightPanelToggle && rightPanelOpen && (
        <aside className={`app-right-panel${rightPanelOpen ? " is-open" : ""}`}>
          <div className="right-panel-header">
            <span>属性</span>
            <button
              type="button"
              className="right-panel-close"
              onClick={() => setRightPanelOpen(false)}
              aria-label="关闭面板"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="right-panel-body">
            <div className="right-panel-placeholder">
              参数面板
            </div>
          </div>
          <button
            type="button"
            className="right-panel-toggle"
            onClick={() => setRightPanelOpen(false)}
            aria-label="收起面板"
          />
        </aside>
      )}

      {isMobile && (
        <BottomNav
          items={BOTTOM_NAV_ITEMS}
          current={view}
          onSelect={(key) => changeView(key as View)}
          ctaAction={() => changeView("dramaStudio")}
        />
      )}
    </div>
  );
}
