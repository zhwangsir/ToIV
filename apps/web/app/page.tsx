"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { LandingPage } from "@/components/landing/LandingPage";
import { Sidebar, type SidebarView } from "@/components/nav/Sidebar";
import { Topbar } from "@/components/nav/Topbar";
import { AssistantView } from "@/components/assistant/AssistantView";
import { CreateView } from "@/components/create/CreateView";
import { CanvasView } from "@/components/canvas/CanvasView";
import { ManjuView } from "@/components/manju/ManjuView";
import { DubView } from "@/components/dub/DubView";
import { TrainView } from "@/components/train/TrainView";
import { LibraryView } from "@/components/library/LibraryView";
import { BacklotView } from "@/components/backlot/BacklotView";
import { ModelsView } from "@/components/models/ModelsView";
import { AdminView } from "@/components/admin/AdminView";
import { fetchMe, getToken, setToken, testLogin } from "@/lib/api";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

type AuthState = "loading" | "in" | "out";

type View =
  | "assistant"
  | "create"
  | "canvas"
  | "manju"
  | "dub"
  | "train"
  | "library"
  | "backlot"
  | "models"
  | "admin";

const VALID_VIEWS = new Set<View>([
  "assistant",
  "create",
  "canvas",
  "manju",
  "dub",
  "train",
  "library",
  "backlot",
  "models",
  "admin",
]);

// 视图元信息:label / breadcrumb / subtitle / group
const VIEW_META: Record<View, { label: string; breadcrumb: string[]; subtitle: string; group: SidebarView["group"] }> = {
  assistant: { label: "AI 助手", breadcrumb: ["对话流"], subtitle: "对话式 AI 创作", group: "dialog" },
  create:    { label: "创作",    breadcrumb: ["工具", "创作"], subtitle: "图像 / 视频生成", group: "tool" },
  canvas:    { label: "ComfyUI", breadcrumb: ["工具", "ComfyUI"], subtitle: "节点工作流", group: "tool" },
  manju:     { label: "漫剧",    breadcrumb: ["工具", "漫剧"], subtitle: "分镜 / 合成", group: "tool" },
  dub:       { label: "译制",    breadcrumb: ["工具", "译制"], subtitle: "配音 / 口型同步", group: "tool" },
  train:     { label: "训练",    breadcrumb: ["工具", "训练"], subtitle: "LoRA 训练", group: "tool" },
  library:   { label: "作品库",  breadcrumb: ["资产", "作品库"], subtitle: "历史作品", group: "asset" },
  backlot:   { label: "看板",    breadcrumb: ["资产", "看板"], subtitle: "项目仪表盘", group: "asset" },
  models:    { label: "模型",    breadcrumb: ["资产", "模型"], subtitle: "模型库 + 市场", group: "asset" },
  admin:     { label: "管理",    breadcrumb: ["资产", "管理"], subtitle: "用户管理", group: "asset" },
};

// 侧栏图标映射
const VIEW_ICONS: Record<View, SidebarView["icon"]> = {
  assistant: "chat",
  create: "create",
  canvas: "canvas",
  manju: "manju",
  dub: "dub",
  train: "train",
  library: "library",
  backlot: "backlot",
  models: "models",
  admin: "admin",
};

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="splash">
          <div className="hero-orb" aria-hidden="true" />
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
  const [view, setView] = useState<View>(() => {
    const v = searchParams.get("view");
    return v && VALID_VIEWS.has(v as View) ? (v as View) : "assistant";
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
          // fetchMe 抛 "会话已过期" 时视为 401 → 清 token 登出;
          // 其他错误(网络抖动 / 5xx / 超时)保留 token,避免用户被踢出
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
  const views: SidebarView[] = useMemo(() => {
    const allViews = (Object.keys(VIEW_META) as View[]).filter(
      (v) => v !== "admin" || isAdmin,
    );
    return allViews.map((v) => ({
      key: v,
      label: VIEW_META[v].label,
      icon: VIEW_ICONS[v],
      group: VIEW_META[v].group,
    }));
  }, [isAdmin]);

  const meta = VIEW_META[view];

  if (auth === "loading") {
    return (
      <div className="splash">
        <div className="hero-orb" aria-hidden="true" />
      </div>
    );
  }

  if (auth === "out") {
    return <LandingPage />;
  }

  return (
    <div className={`app-shell${sidebarOpen ? " is-sidebar-open" : ""}`}>
      <Topbar
        account={account ?? undefined}
        onLogout={onLogout}
        onMenuToggle={() => setSidebarOpen((v) => !v)}
        menuOpen={sidebarOpen}
        breadcrumb={meta.breadcrumb}
        subtitle={meta.subtitle}
      />

      <Sidebar
        views={views}
        current={view}
        onSelect={(key) => {
          changeView(key as View);
          setSidebarOpen(false);
        }}
        account={account ?? undefined}
        onLogout={onLogout}
      />

      <main id="main" className="app-main">
        <div className="view-root">
          {/* key={view}:切换视图时强制重新挂载 ErrorBoundary,自动重置上一视图的错误状态 */}
          <ErrorBoundary key={view} viewName={meta.label}>
            {view === "assistant" && <AssistantView />}
            {view === "create" && <CreateView />}
            {view === "canvas" && <CanvasView />}
            {view === "manju" && <ManjuView />}
            {view === "dub" && <DubView />}
            {view === "train" && <TrainView />}
            {view === "library" && <LibraryView />}
            {view === "backlot" && <BacklotView />}
            {view === "models" && <ModelsView />}
            {view === "admin" && <AdminView />}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
