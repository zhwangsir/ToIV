"use client";

import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";

import { LandingPage } from "@/components/landing/LandingPage";
import { CornerNav, type CornerNavItem } from "@/components/nav/CornerNav";
import { BottomNav, type BottomNavItem } from "@/components/nav/BottomNav";
import { fetchMe, getToken, setToken, testLogin } from "@/lib/api";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Icon } from "@/components/ui/Icon";

type AuthState = "loading" | "in" | "out";

type View =
  | "assistant"
  | "image"
  | "video"
  | "audio"
  | "fusion"
  | "imageEdit"
  | "videoEdit"
  | "animatic"
  | "avatartalk"
  | "canvas"
  | "studio"
  | "dub"
  | "train"
  | "library"
  | "backlot"
  | "models"
  | "resources"
  | "settings"
  | "admin";

/** M1 三大板块拆分:generate 退役拆为 图片/视频/音频,旧链接按 kind 重定向(不 404)。
 *  M4 studio 替代短剧/漫剧:旧 key 一律重定向到 studio。 */
const LEGACY_VIEW_REDIRECTS: Record<string, View> = {
  create: "image",
  generate: "image",
  ltxstudio: "video",
  dramaStudio: "studio",
  manju: "studio",
  "video-edit": "videoEdit",
  "image-edit": "imageEdit",
};

/** 解析 ?view= 参数:旧 key 走重定向,非法 key 返回 null(落默认视图)。 */
function resolveView(raw: string | null): View | null {
  if (!raw) return null;
  const redirected = LEGACY_VIEW_REDIRECTS[raw];
  if (redirected) return redirected;
  return VALID_VIEWS.has(raw as View) ? (raw as View) : null;
}

// ── 视图懒加载:chunk 按需拉取;灵动岛悬停/聚焦期间并行预热,消除切换白屏等待 ──
const viewImporters = {
  assistant: () => import("@/components/assistant/AssistantView"),
  // 图片/视频共用 GenerateView chunk;音频走 AudioView(内嵌 GenerateView,webpack 共享 chunk)
  image: () => import("@/components/generate/GenerateView"),
  video: () => import("@/components/generate/GenerateView"),
  audio: () => import("@/components/audio/AudioView"),
  fusion: () => import("@/components/fusion/FusionView"),
  imageEdit: () => import("@/components/image-edit/ImageEditView"),
  videoEdit: () => import("@/components/video-edit/VideoEditView"),
  animatic: () => import("@/components/animatic/AnimaticView"),
  avatartalk: () => import("@/components/avatartalk/AvatarTalkView"),
  canvas: () => import("@/components/canvas/CanvasView"),
  studio: () => import("@/components/studio/StudioView"),
  dub: () => import("@/components/dub/DubView"),
  train: () => import("@/components/train/TrainView"),
  library: () => import("@/components/library/LibraryView"),
  backlot: () => import("@/components/backlot/BacklotView"),
  models: () => import("@/components/models/ModelsView"),
  resources: () => import("@/components/resources/ResourcesView"),
  settings: () => import("@/components/settings/SettingsView"),
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
  viewImporters.image().then((m) => ({ default: m.GenerateView })),
);
const AudioView = lazy(() =>
  viewImporters.audio().then((m) => ({ default: m.AudioView })),
);
const FusionView = lazy(() =>
  viewImporters.fusion().then((m) => ({ default: m.FusionView })),
);
const ImageEditView = lazy(() =>
  viewImporters.imageEdit().then((m) => ({ default: m.ImageEditView })),
);
const VideoEditView = lazy(() =>
  viewImporters.videoEdit().then((m) => ({ default: m.VideoEditView })),
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
const StudioView = lazy(() =>
  viewImporters.studio().then((m) => ({ default: m.StudioView })),
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
const SettingsView = lazy(() =>
  viewImporters.settings().then((m) => ({ default: m.SettingsView })),
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
// create/generate/ltxstudio/dramaStudio/manju 不在此列——经 LEGACY_VIEW_REDIRECTS 重定向
const VALID_VIEWS = new Set<View>([
  "assistant",
  "image",
  "video",
  "audio",
  "fusion",
  "imageEdit",
  "videoEdit",
  "animatic",
  "avatartalk",
  "canvas",
  "studio",
  "dub",
  "train",
  "library",
  "backlot",
  "models",
  "resources",
  "settings",
  "admin",
]);

const VIEW_META: Record<View, { label: string }> = {
  assistant: { label: "对话" },
  image:     { label: "图片" },
  video:     { label: "视频" },
  audio:     { label: "音频" },
  fusion:    { label: "融合" },
  imageEdit: { label: "图片编辑" },
  videoEdit: { label: "视频剪辑" },
  animatic:  { label: "动态分镜" },
  avatartalk: { label: "数字人" },
  canvas:    { label: "画布" },
  studio:    { label: "创作" },
  dub:       { label: "译制" },
  train:     { label: "训练" },
  library:   { label: "作品库" },
  backlot:   { label: "看板" },
  models:    { label: "模型" },
  resources: { label: "资源" },
  settings:  { label: "设置" },
  admin:     { label: "管理" },
};

/** M3 新 IA 一级入口 8 项:三大板块 + 融合聚合页;短剧/数字人/译制移入融合,视图保留(旧链接不 404)。
 *  桌面端由左上角悬停展开导航(CornerNav)承载,窄屏由底部导航承载。 */
const ISLAND_ITEMS: CornerNavItem[] = [
  { key: "assistant", label: "对话", icon: "chat" },
  { key: "image", label: "图片", icon: "image" },
  { key: "video", label: "视频", icon: "video" },
  { key: "audio", label: "音频", icon: "audio" },
  { key: "fusion", label: "融合", icon: "sparkles" },
  { key: "canvas", label: "画布", icon: "workflow" },
  { key: "library", label: "作品库", icon: "library" },
  { key: "resources", label: "资源", icon: "models" },
];

/** 窄屏底部导航:主入口 5 个(含 CTA)+「更多」抽屉承载其余 */
const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  { key: "assistant", label: "对话", icon: "chat" },
  { key: "image", label: "图片", icon: "image" },
  { key: "video", label: "视频", icon: "video" },
  { key: "fusion", label: "融合", icon: "sparkles", isCta: true },
  { key: "library", label: "作品", icon: "library" },
];

const BOTTOM_NAV_MORE_ITEMS: BottomNavItem[] = [
  { key: "audio", label: "音频", icon: "audio" },
  { key: "imageEdit", label: "图片编辑", icon: "wand" },
  { key: "videoEdit", label: "视频剪辑", icon: "scissors" },
  { key: "canvas", label: "画布", icon: "workflow" },
  { key: "studio", label: "创作", icon: "clapperboard" },
  { key: "avatartalk", label: "数字人", icon: "user" },
  { key: "dub", label: "译制", icon: "dub" },
  { key: "animatic", label: "动态分镜", icon: "clapperboard" },
  { key: "resources", label: "资源", icon: "models" },
  { key: "settings", label: "设置", icon: "settings" },
];

/** WS5:视图切换走 View Transitions(主舞台 cross-fade,样式见 styles/motion.css)。
 *  存在性守卫:不支持的浏览器直接执行原逻辑,不引入 polyfill。
 *  flushSync 让 React 在快照回调内同步提交 DOM,否则新快照仍是旧视图。 */
function withViewTransition(update: () => void) {
  const doc = document as Document & {
    startViewTransition?: (updateCallback: () => void) => unknown;
  };
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(() => flushSync(update));
  } else {
    update();
  }
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
  const [auth, setAuth] = useState<AuthState>("loading");
  const [account, setAccount] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => resolveView(searchParams.get("view")) ?? "assistant");

  useEffect(() => {
    const raw = searchParams.get("view");
    const resolved = resolveView(raw);
    if (resolved && resolved !== view) {
      setView(resolved);
    }
    // 旧 key(create/generate/ltxstudio)重定向后把 URL 规整为新 key,刷新/分享保持一致
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
      withViewTransition(() => {
        setView(next);
        router.replace(`/?view=${next}`);
      });
    },
    [router],
  );

  // 动态分镜 AI 模式:解析成功后跳 studio 创作工作室(旧 drama 工作台已退役)
  const handleOpenDramaProject = useCallback(() => {
    changeView("studio");
  }, [changeView]);

  // 融合聚合页跳转:target 可带查询串(如 dramaStudio?mode=manju 进漫剧模式)
  const handleFusionNavigate = useCallback(
    (target: string) => {
      const [key, query] = target.split("?", 2);
      const next = resolveView(key) ?? "assistant";
      preloadView(next);
      withViewTransition(() => {
        setView(next);
        router.replace(`/?view=${next}${query ? `&${query}` : ""}`);
      });
    },
    [router],
  );

  // 灵动岛项悬停/聚焦:按操作意向精确预热目标视图
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

  return (
    <div className="app-shell">
      <CornerNav
        items={ISLAND_ITEMS}
        current={view}
        onSelect={(key) => changeView(key as View)}
        onItemIntent={handleViewIntent}
        account={account}
        onLogout={onLogout}
      />

      <main id="main" className={`app-main${view === "avatartalk" ? " avatartalk-main" : ""}`}>
        <div className="view-root view-stage">
          <ErrorBoundary key={view} viewName={meta.label}>
            <Suspense fallback={<ViewFallback label={meta.label} />}>
              {view === "assistant" && <AssistantView />}
              {view === "image" && <GenerateView lockedKind="image" />}
              {view === "video" && <GenerateView lockedKind="video" />}
              {view === "audio" && <AudioView />}
              {view === "fusion" && <FusionView onNavigate={handleFusionNavigate} />}
              {view === "imageEdit" && <ImageEditView />}
              {view === "videoEdit" && <VideoEditView />}
              {view === "canvas" && <CanvasView />}
              {view === "studio" && <StudioView />}
              {view === "dub" && <DubView />}
              {view === "animatic" && (
                // 动态分镜全端统一:AnimaticView 为唯一实现(旧桌面端 FROZEN 视图已物理删除)
                <AnimaticView onOpenDramaProject={handleOpenDramaProject} />
              )}
              {view === "avatartalk" && <AvatarTalkView />}
              {view === "train" && <TrainView />}
              {view === "library" && <LibraryView onNavigate={handleFusionNavigate} />}
              {view === "backlot" && <BacklotView />}
              {view === "models" && <ModelsView />}
              {view === "resources" && <ResourcesView showAdmin={isAdmin} />}
              {view === "settings" && <SettingsView account={account} onLogout={onLogout} />}
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
        ctaAction={() => changeView("fusion")}
      />
    </div>
  );
}
