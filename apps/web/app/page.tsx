"use client";

import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { LandingPage } from "@/components/landing/LandingPage";
import { Sidebar, type SidebarNavItem } from "@/components/nav/Sidebar";
import { BottomNav, type BottomNavItem } from "@/components/nav/BottomNav";
import { fetchMe, getToken, setToken, testLogin } from "@/lib/api";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Icon } from "@/components/ui/Icon";

type AuthState = "loading" | "in" | "out";

type View =
  | "assistant"
  | "generate"
  | "animatic"
  | "avatartalk"
  | "canvas"
  | "dramaStudio"
  | "dub"
  | "train"
  | "library"
  | "backlot"
  | "models"
  | "resources"
  | "admin";

/** W3 旧视图退役:create/video/ltxstudio 已由统一生成工作台取代,旧链接重定向到 generate(不 404)。 */
const LEGACY_VIEW_REDIRECTS: Record<string, View> = {
  create: "generate",
  video: "generate",
  ltxstudio: "generate",
};

/** 解析 ?view= 参数:旧 key 走重定向,非法 key 返回 null(落默认视图)。 */
function resolveView(raw: string | null): View | null {
  if (!raw) return null;
  const redirected = LEGACY_VIEW_REDIRECTS[raw];
  if (redirected) return redirected;
  return VALID_VIEWS.has(raw as View) ? (raw as View) : null;
}

// ── 视图懒加载:chunk 按需拉取;侧栏悬停/聚焦期间并行预热,消除切换白屏等待 ──
const viewImporters = {
  assistant: () => import("@/components/assistant/AssistantView"),
  generate: () => import("@/components/generate/GenerateView"),
  animatic: () => import("@/components/animatic/AnimaticView"),
  avatartalk: () => import("@/components/avatartalk/AvatarTalkView"),
  canvas: () => import("@/components/canvas/CanvasView"),
  dramaStudio: () => import("@/components/drama-studio/DramaStudioView"),
  dub: () => import("@/components/dub/DubView"),
  train: () => import("@/components/train/TrainView"),
  library: () => import("@/components/library/LibraryView"),
  backlot: () => import("@/components/backlot/BacklotView"),
  models: () => import("@/components/models/ModelsView"),
  resources: () => import("@/components/resources/ResourcesView"),
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
const GenerateView = lazy(() =>
  viewImporters.generate().then((m) => ({ default: m.GenerateView })),
);
const AnimaticView = lazy(() =>
  viewImporters.animatic().then((m) => ({ default: m.AnimaticView })),
);
const AvatarTalkView = lazy(() =>
  viewImporters.avatartalk().then((m) => ({ default: m.AvatarTalkView })),
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
const ResourcesView = lazy(() =>
  viewImporters.resources().then((m) => ({ default: m.ResourcesView })),
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

// 旧视图 key(models/train/backlot/admin)保留兼容,旧链接不 404;
// create/video/ltxstudio 不在此列——经 LEGACY_VIEW_REDIRECTS 重定向到 generate
const VALID_VIEWS = new Set<View>([
  "assistant",
  "generate",
  "animatic",
  "avatartalk",
  "canvas",
  "dramaStudio",
  "dub",
  "train",
  "library",
  "backlot",
  "models",
  "resources",
  "admin",
]);

const VIEW_META: Record<View, { label: string }> = {
  assistant: { label: "对话" },
  generate:  { label: "生成" },
  animatic:  { label: "动态分镜" },
  avatartalk: { label: "数字人" },
  canvas:    { label: "画布" },
  dramaStudio: { label: "短剧" },
  dub:       { label: "译制" },
  train:     { label: "训练" },
  library:   { label: "作品库" },
  backlot:   { label: "看板" },
  models:    { label: "模型" },
  resources: { label: "资源" },
  admin:     { label: "管理" },
};

/** 新 IA 一级入口(定调文档 8 入口);动态分镜保留独立 key,短剧并入是 W2 的事 */
const SIDEBAR_ITEMS: SidebarNavItem[] = [
  { key: "assistant", label: "对话", icon: "chat" },
  { key: "generate", label: "生成", icon: "sparkles" },
  { key: "dramaStudio", label: "短剧", icon: "drama" },
  { key: "avatartalk", label: "数字人", icon: "user" },
  { key: "canvas", label: "画布", icon: "workflow" },
  { key: "dub", label: "译制", icon: "dub" },
  { key: "library", label: "作品库", icon: "library" },
  { key: "resources", label: "资源", icon: "models" },
];

/** 窄屏底部导航:主入口 5 个(含 CTA)+「更多」抽屉承载其余 */
const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  { key: "assistant", label: "对话", icon: "chat" },
  { key: "generate", label: "生成", icon: "sparkles" },
  { key: "dramaStudio", label: "短剧", icon: "plus", isCta: true },
  { key: "library", label: "作品", icon: "library" },
];

const BOTTOM_NAV_MORE_ITEMS: BottomNavItem[] = [
  { key: "avatartalk", label: "数字人", icon: "user" },
  { key: "canvas", label: "画布", icon: "workflow" },
  { key: "dub", label: "译制", icon: "dub" },
  { key: "animatic", label: "动态分镜", icon: "clapperboard" },
  { key: "resources", label: "资源", icon: "models" },
];

const SIDEBAR_COLLAPSED_KEY = "toiv_sidebar_collapsed";

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
  const [view, setView] = useState<View>(() => resolveView(searchParams.get("view")) ?? "assistant");
  // 侧栏折叠状态(localStorage 记忆);SSR 默认展开,挂载后读取
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 动态分镜 AI 解析成功后,带项目 id 跳转短剧工作室并直接打开
  const [pendingDramaProjectId, setPendingDramaProjectId] = useState<string | null>(null);

  useEffect(() => {
    try {
      setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
    } catch {
      /* 隐私模式等场景读不到即保持展开 */
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* 忽略持久化失败 */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const raw = searchParams.get("view");
    const resolved = resolveView(raw);
    if (resolved && resolved !== view) {
      setView(resolved);
    }
    // 旧 key(create/video/ltxstudio)重定向后把 URL 规整为新 key,刷新/分享保持一致
    if (raw && LEGACY_VIEW_REDIRECTS[raw]) {
      router.replace(`/?view=${resolved ?? "assistant"}`);
    }
  }, [searchParams, view, router]);

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

  // 动态分镜 AI 模式:解析成功后跳短剧工作室并打开对应项目
  const handleOpenDramaProject = useCallback(
    (projectId: string) => {
      setPendingDramaProjectId(projectId);
      changeView("dramaStudio");
    },
    [changeView],
  );

  // 侧栏项悬停/聚焦:按操作意向精确预热目标视图
  const handleViewIntent = useCallback((key: string) => {
    if (VALID_VIEWS.has(key as View)) preloadView(key as View);
  }, []);

  const isAdmin = account === "admin";
  const meta = VIEW_META[view];

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

  const shellClasses = ["app-shell", sidebarCollapsed ? "is-collapsed" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClasses}>
      <Sidebar
        items={SIDEBAR_ITEMS}
        current={view}
        onSelect={(key) => changeView(key as View)}
        onItemIntent={handleViewIntent}
        account={account}
        onLogout={onLogout}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
      />

      <main id="main" className={`app-main${view === "avatartalk" ? " avatartalk-main" : ""}`}>
        <div className="view-root">
          <ErrorBoundary key={view} viewName={meta.label}>
            <Suspense fallback={<ViewFallback label={meta.label} />}>
              {view === "assistant" && <AssistantView />}
              {view === "generate" && <GenerateView />}
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
                        返回对话
                      </button>
                    </div>
                  </div>
                ) : (
                  <DramaStudioView
                    account={account ?? undefined}
                    onLogout={onLogout}
                    onNavigate={(next) => changeView(next as View)}
                    initialProjectId={pendingDramaProjectId}
                    onConsumeInitialProject={() => setPendingDramaProjectId(null)}
                  />
                )
              )}
              {view === "dub" && <DubView />}
              {view === "animatic" && (
                // 动态分镜并入短剧首页:桌面端走 DramaStudioView 的「动态分镜」页签;
                // 移动端短剧工作室有拦截,保留独立 AnimaticView 保证可用
                isMobile ? (
                  <AnimaticView onOpenDramaProject={handleOpenDramaProject} />
                ) : (
                  <DramaStudioView
                    account={account ?? undefined}
                    onLogout={onLogout}
                    onNavigate={(next) => changeView(next as View)}
                    initialProjectId={pendingDramaProjectId}
                    onConsumeInitialProject={() => setPendingDramaProjectId(null)}
                    initialHubTab="animatic"
                  />
                )
              )}
              {view === "avatartalk" && <AvatarTalkView />}
              {view === "train" && <TrainView />}
              {view === "library" && <LibraryView />}
              {view === "backlot" && <BacklotView />}
              {view === "models" && <ModelsView />}
              {view === "resources" && <ResourcesView showAdmin={isAdmin} />}
              {view === "admin" && <AdminView />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      <BottomNav
        items={BOTTOM_NAV_ITEMS}
        moreItems={BOTTOM_NAV_MORE_ITEMS}
        current={view}
        onSelect={(key) => changeView(key as View)}
        ctaAction={() => changeView("dramaStudio")}
      />
    </div>
  );
}
