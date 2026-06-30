"use client";

import { useCallback, useEffect, useState } from "react";
import { MotionConfig } from "framer-motion";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { CreateStudio } from "@/components/create/CreateStudio";
import { ActivityProvider } from "@/components/nav/ActivityContext";
import { NsfwProvider, useNsfw } from "@/components/nav/NsfwContext";
import { fetchMe, getToken, setToken } from "@/lib/api";
import type { AuthResult } from "@/lib/api";

/**
 * R18 私享创作 —— 独立隐藏页,仅通过 /nsfw 路径进入(任何导航都无入口)。
 * 进入即开启账户 R18(后端 R18 门槛需 nsfw_enabled),复用功能最全的 CreateStudio(强制 R18 档)。
 */
function NsfwInner() {
  const { enabled, setEnabled, loading } = useNsfw();
  // 进入即开 R18:账户未开则静默开启(后端据此放行成人底模 + 重拉 R18 模型列表)
  useEffect(() => {
    if (!loading && !enabled) setEnabled(true).catch(() => {});
  }, [loading, enabled, setEnabled]);

  return (
    <div className="app-shell nsfw-shell">
      <header className="nsfw-topbar">
        <span className="nsfw-brand">
          R18 <span className="grad">私享创作</span>
        </span>
        <span className="nsfw-tag">18+</span>
        <span className="nsfw-hint">独立隐藏页 · 仅 /nsfw 直达</span>
      </header>
      <CreateStudio forceNsfw />
    </div>
  );
}

export default function NsfwPage() {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");

  useEffect(() => {
    if (!getToken()) {
      setAuth("out");
      return;
    }
    fetchMe()
      .then(() => setAuth("in"))
      .catch(() => {
        setToken(null);
        setAuth("out");
      });
  }, []);

  const onAuthed = useCallback((_r: AuthResult) => setAuth("in"), []);

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
        <NsfwProvider>
          <NsfwInner />
        </NsfwProvider>
      </ActivityProvider>
    </MotionConfig>
  );
}
