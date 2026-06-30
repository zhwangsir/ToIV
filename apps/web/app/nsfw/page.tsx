"use client";

import { useCallback, useEffect, useState } from "react";
import { MotionConfig } from "framer-motion";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { CreateStudio } from "@/components/create/CreateStudio";
import { ActivityProvider } from "@/components/nav/ActivityContext";
import { NsfwProvider } from "@/components/nav/NsfwContext";
import { fetchMe, getToken, setNsfwIntent, setToken } from "@/lib/api";
import type { AuthResult } from "@/lib/api";

/**
 * R18 私享创作 —— 独立隐藏页,仅通过 /nsfw 路径进入(任何导航都无入口)。
 * 按请求带 X-NSFW 标记(setNsfwIntent)放行 R18,**不动账户全局开关** → 主页/作品库零痕迹。
 * 复用功能最全的 CreateStudio(强制 R18 档)。
 */
function NsfwInner() {
  // 同步置位:必须早于子组件 CreateStudio 的 listModels(React 子 effect 先于父 effect)。
  // 离开本页复位,防模块级标记残留泄漏到主页。
  setNsfwIntent(true);
  useEffect(() => () => setNsfwIntent(false), []);

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
