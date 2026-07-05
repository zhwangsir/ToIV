"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";

import { LandingPage } from "@/components/landing/LandingPage";
import { AdminPanel } from "@/components/admin/AdminPanel";
import { AssistantView } from "@/components/assistant/AssistantView";
import { CanvasStudio } from "@/components/canvas/CanvasStudio";
import { CreateStudio } from "@/components/create/CreateStudio";
import { DubStudio } from "@/components/dub/DubStudio";
import { LibraryView } from "@/components/library/LibraryView";
import { ManjuStudio } from "@/components/manju/ManjuStudio";
import { ModelLibrary } from "@/components/models/ModelLibrary";
import { ActivityProvider } from "@/components/nav/ActivityContext";
import { NsfwProvider } from "@/components/nav/NsfwContext";
import { Topbar, type TopbarView } from "@/components/nav/Topbar";
import { viewVariants } from "@/lib/motion";
import { fetchMe, getToken, setToken, testLogin } from "@/lib/api";

type AuthState = "loading" | "in" | "out";

type View =
  | "assistant"
  | "create"
  | "canvas"
  | "manju"
  | "dub"
  | "library"
  | "models"
  | "admin";

// 合法深链视图(/?view=<模块>);从 /engine 落地页能力卡进入时初始化对应视图。
// 3D / 音频 已收进「创作」的 mode;设计(CAD)已拆为独立 BIM 项目,故不再是顶层视图。
const VALID_VIEWS = new Set<View>([
  "assistant",
  "create",
  "canvas",
  "manju",
  "dub",
  "library",
  "models",
  "admin",
]);

interface Account {
  email: string;
  role: string;
  usageTotal: number;
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState>("loading");
  const [account, setAccount] = useState<Account | null>(null);
  const [view, setView] = useState<View>("assistant");

  // 深链:/?view=<模块> 直接进入对应视图(承接 /engine 落地页能力卡跳转)
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v && VALID_VIEWS.has(v as View)) setView(v as View);
  }, []);

  // 启动时:AI 测试通道(URL 令牌/密钥,免登录表单)→ 再校验已存令牌
  useEffect(() => {
    (async () => {
      // /?t=<token> 直接注入令牌;/?testkey=<key> 用密钥换令牌(见 auth/test-login)
      const params = new URLSearchParams(window.location.search);
      const t = params.get("t");
      const testkey = params.get("testkey");
      if (t || testkey) {
        try {
          if (t) setToken(t);
          else if (testkey) setToken((await testLogin(testkey)).token);
        } catch {
          /* 密钥错/通道未开 → 落回正常登录流程 */
        }
        // 清掉地址栏的令牌/密钥参数,避免留痕
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
          setAccount({ email: me.user.email, role: me.user.role, usageTotal: me.usage.total });
          setAuth("in");
        })
        .catch(() => {
          setToken(null);
          setAuth("out");
        });
    })();
  }, []);

  const onLogout = useCallback(() => {
    setToken(null);
    setAccount(null);
    setAuth("out");
  }, []);

  // 灵动岛视图项:key 即 View 值,onSelect 直接回传给 setView(单一真相,无映射层)。
  // useMemo 稳定引用:仅在管理员身份变化时重建,否则保持同一数组,
  // 让灵动岛 memo 化的顶行不因父级无关重渲(如生成进度刷新)而重建。
  const isAdmin = account?.role === "admin";
  const views: TopbarView[] = useMemo(
    () => [
      { key: "assistant", label: "AI 助手", icon: "assistant" },
      { key: "create", label: "创作", icon: "image" },
      { key: "canvas", label: "画布", icon: "image" },
      { key: "manju", label: "漫剧", icon: "video" },
      { key: "dub", label: "译制", icon: "audio" },
      { key: "library", label: "作品库", icon: "library" },
      { key: "models", label: "模型", icon: "models" },
      ...(isAdmin ? [{ key: "admin", label: "管理", icon: "admin" }] : []),
    ],
    [isAdmin],
  );

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
    <MotionConfig reducedMotion="user">
      <ActivityProvider>
        <NsfwProvider>
        <div className="app-shell has-topbar">
          <Topbar<View>
            views={views}
            current={view}
            onSelect={setView}
            account={account?.email}
            onLogout={onLogout}
          />

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              className="view-root"
              variants={viewVariants}
              initial="initial"
              animate="enter"
              exit="exit"
            >
              {view === "assistant" ? (
                <div className="single-view">
                  <AssistantView />
                </div>
              ) : view === "canvas" ? (
                <CanvasStudio />
              ) : view === "manju" ? (
                <ManjuStudio />
              ) : view === "dub" ? (
                <DubStudio />
              ) : view === "admin" ? (
                <div className="single-view">
                  <AdminPanel />
                </div>
              ) : view === "library" ? (
                <div className="single-view">
                  <LibraryView />
                </div>
              ) : view === "models" ? (
                <div className="single-view">
                  <ModelLibrary />
                </div>
              ) : (
                <CreateStudio />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        </NsfwProvider>
      </ActivityProvider>
    </MotionConfig>
  );
}
