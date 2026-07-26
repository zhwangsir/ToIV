"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { LandingPage } from "@/components/landing/LandingPage";
import { DynamicIsland, type DynamicIslandView } from "@/components/nav/DynamicIsland";
import { Topbar } from "@/components/nav/Topbar";
import { BottomNav, type BottomNavItem } from "@/components/nav/BottomNav";
import { ModeSwitcher } from "@/components/ui/ModeSwitcher";
import { AssistantView } from "@/components/assistant/AssistantView";
import { CreateView } from "@/components/create/CreateView";
import { VideoView } from "@/components/create/VideoView";
import { CanvasView } from "@/components/canvas/CanvasView";
import { ManjuView } from "@/components/manju/ManjuView";
import { DramaStudioView } from "@/components/drama-studio/DramaStudioView";
import { DubView } from "@/components/dub/DubView";
import { TrainView } from "@/components/train/TrainView";
import { LibraryView } from "@/components/library/LibraryView";
import { BacklotView } from "@/components/backlot/BacklotView";
import { ModelsView } from "@/components/models/ModelsView";
import { AdminView } from "@/components/admin/AdminView";
import { AvatarTalkView } from "@/components/avatartalk/AvatarTalkView";
import { fetchMe, getToken, setToken, testLogin } from "@/lib/api";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Icon } from "@/components/ui/Icon";

type AuthState = "loading" | "in" | "out";
type AppMode = "canvas" | "studio";

type View =
  | "assistant"
  | "avatartalk"
  | "create"
  | "video"
  | "canvas"
  | "manju"
  | "dramaStudio"
  | "dub"
  | "train"
  | "library"
  | "backlot"
  | "models"
  | "admin";

const VALID_VIEWS = new Set<View>([
  "assistant",
  "avatartalk",
  "create",
  "video",
  "canvas",
  "manju",
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
  manju:     { label: "漫剧" },
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
  const [appMode, setAppMode] = useState<AppMode>("canvas");

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
      setView(next);
      router.replace(`/?view=${next}`);
    },
    [router],
  );

  const isAdmin = account === "admin";

  const diViews: DynamicIslandView[] = useMemo(() => {
    return [
      { key: "assistant", label: "AI 助手", icon: "chat", group: "main" },
      { key: "avatartalk", label: "数字人", icon: "user", group: "main" },
      { key: "canvas", label: "画布", icon: "canvas", group: "main" },
      { key: "create", label: "图像创作", icon: "create", group: "tools" },
      { key: "video", label: "视频生成", icon: "video", group: "tools" },
      { key: "manju", label: "漫剧", icon: "manju", group: "tools" },
      { key: "dramaStudio", label: "短剧工作室", icon: "drama", group: "tools" },
      { key: "dub", label: "译制配音", icon: "dub", group: "tools" },
      { key: "library", label: "作品库", icon: "library", group: "resources" },
      { key: "models", label: "模型库", icon: "models", group: "resources" },
      ...(isAdmin ? [{ key: "admin", label: "管理", icon: "admin" as const, group: "resources" as const }] : []),
    ];
  }, [isAdmin]);

  const meta = VIEW_META[view];
  const showRightPanelToggle = view === "canvas" || view === "create" || view === "video";
  const showModeSwitcher = view === "canvas" || view === "dramaStudio";

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

  if (view === "dramaStudio" && !isMobile) {
    return (
      <DramaStudioView
        account={account ?? undefined}
        onLogout={onLogout}
        onNavigate={(next) => changeView(next as View)}
      />
    );
  }

  if (view === "avatartalk") {
    return (
      <div className="app-shell avatartalk-shell">
        <DynamicIsland
          views={diViews}
          current={view}
          onSelect={(key) => changeView(key as View)}
        />
        <main className="app-main avatartalk-main">
          <ErrorBoundary viewName="数字人对话">
            <AvatarTalkView />
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
      />

      <Topbar
        account={account ?? undefined}
        onLogout={onLogout}
        onRightPanelToggle={showRightPanelToggle ? () => setRightPanelOpen((v) => !v) : undefined}
        rightPanelOpen={rightPanelOpen}
      />

      <main id="main" className="app-main">
        {showModeSwitcher && (
          <ModeSwitcher mode={appMode} onChange={setAppMode} />
        )}
        <div className="view-root">
          <ErrorBoundary key={view} viewName={meta.label}>
            {view === "assistant" && <AssistantView />}
            {view === "create" && <CreateView />}
            {view === "video" && <VideoView />}
            {view === "canvas" && <CanvasView />}
            {view === "manju" && <ManjuView />}
            {view === "dramaStudio" && isMobile && (
              <div className="single-view">
                <div className="empty-state">
                  <div className="empty-state-icon">
                    <Icon name="drama" size={48} />
                  </div>
                  <h3 className="empty-state-title">短剧工作室</h3>
                  <p className="empty-state-desc">
                    短剧工作室建议在桌面端或平板横屏模式下使用，以获得最佳体验。
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => changeView("canvas")}
                  >
                    返回画布模式
                  </button>
                </div>
              </div>
            )}
            {view === "dub" && <DubView />}
            {view === "train" && <TrainView />}
            {view === "library" && <LibraryView />}
            {view === "backlot" && <BacklotView />}
            {view === "models" && <ModelsView />}
            {view === "admin" && <AdminView />}
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
            {view === "canvas" && (
              <div className="right-panel-placeholder">
                选中节点后将显示节点属性面板。
              </div>
            )}
            {(view === "create" || view === "video") && (
              <div className="right-panel-placeholder">
                参数面板
              </div>
            )}
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
