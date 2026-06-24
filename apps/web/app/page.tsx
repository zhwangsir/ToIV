"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { AdminPanel } from "@/components/admin/AdminPanel";
import { AssistantView } from "@/components/assistant/AssistantView";
import { AudioStudio } from "@/components/audio/AudioStudio";
import { CanvasStudio } from "@/components/canvas/CanvasStudio";
import { CreateStudio } from "@/components/create/CreateStudio";
import { LibraryView } from "@/components/library/LibraryView";
import { ManjuStudio } from "@/components/manju/ManjuStudio";
import { ModelLibrary } from "@/components/models/ModelLibrary";
import { ThreeDStudio } from "@/components/threed/ThreeDStudio";
import { ActivityProvider } from "@/components/nav/ActivityContext";
import { DynamicIsland, type IslandView } from "@/components/nav/DynamicIsland";
import { viewVariants } from "@/lib/motion";
import { fetchMe, getToken, setToken } from "@/lib/api";
import type { AuthResult } from "@/lib/api";

type AuthState = "loading" | "in" | "out";

type View = "assistant" | "create" | "canvas" | "manju" | "threed" | "audio" | "library" | "models" | "admin";

interface Account {
  email: string;
  role: string;
  usageTotal: number;
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState>("loading");
  const [account, setAccount] = useState<Account | null>(null);
  const [view, setView] = useState<View>("assistant");

  // 启动时校验已存令牌
  useEffect(() => {
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
  }, []);

  const onAuthed = useCallback((result: AuthResult) => {
    setAccount({ email: result.user.email, role: result.user.role, usageTotal: 0 });
    setAuth("in");
    fetchMe()
      .then((me) =>
        setAccount({ email: me.user.email, role: me.user.role, usageTotal: me.usage.total }),
      )
      .catch(() => {});
  }, []);

  const onLogout = useCallback(() => {
    setToken(null);
    setAccount(null);
    setAuth("out");
  }, []);

  // 灵动岛视图项:key 即 View 值,onSelect 直接回传给 setView(单一真相,无映射层)。
  const islandViews: IslandView[] = [
    { key: "assistant", label: "AI 助手", icon: "assistant" },
    { key: "create", label: "创作", icon: "image" },
    { key: "canvas", label: "画布", icon: "image" },
    { key: "manju", label: "漫剧", icon: "video" },
    { key: "threed", label: "3D", icon: "threed" },
    { key: "library", label: "作品库", icon: "library" },
    { key: "models", label: "模型", icon: "models" },
    ...(account?.role === "admin"
      ? [{ key: "admin", label: "管理", icon: "admin" }]
      : []),
    { key: "audio", label: "音频", icon: "audio" },
  ];

  if (auth === "loading") {
    return (
      <div className="splash">
        <div className="hero-orb" aria-hidden="true" />
      </div>
    );
  }

  if (auth === "out") {
    return <AuthScreen onAuthed={onAuthed} />;
  }

  return (
    <MotionConfig reducedMotion="user">
      <ActivityProvider>
        <div className="app-shell has-island">
          <DynamicIsland<View>
            views={islandViews}
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
              ) : view === "create" ? (
                <CreateStudio />
              ) : view === "canvas" ? (
                <CanvasStudio />
              ) : view === "manju" ? (
                <ManjuStudio />
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
              ) : view === "threed" ? (
                <ThreeDStudio />
              ) : (
                <AudioStudio />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </ActivityProvider>
    </MotionConfig>
  );
}
