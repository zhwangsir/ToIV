"use client";

import { useCallback, useEffect, useState } from "react";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { AdminPanel } from "@/components/admin/AdminPanel";
import { AssistantView } from "@/components/assistant/AssistantView";
import { AudioStudio } from "@/components/audio/AudioStudio";
import { CreateStudio } from "@/components/create/CreateStudio";
import { LibraryView } from "@/components/library/LibraryView";
import { ManjuStudio } from "@/components/manju/ManjuStudio";
import { ModelLibrary } from "@/components/models/ModelLibrary";
import { ThreeDStudio } from "@/components/threed/ThreeDStudio";
import { NavIcon } from "@/components/ui/NavIcon";
import { fetchMe, getToken, setToken } from "@/lib/api";
import type { AuthResult } from "@/lib/api";

type AuthState = "loading" | "in" | "out";

type View = "assistant" | "create" | "manju" | "threed" | "audio" | "library" | "models" | "admin";

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

  const navItems: { key: string; label: string; icon: string; view: View }[] = [
    { key: "assistant", label: "AI 助手", icon: "assistant", view: "assistant" },
    { key: "create", label: "创作", icon: "image", view: "create" },
    { key: "manju", label: "🎬 漫剧", icon: "video", view: "manju" },
    { key: "3d", label: "3D", icon: "threed", view: "threed" },
    { key: "library", label: "作品库", icon: "library", view: "library" },
    { key: "models", label: "模型", icon: "models", view: "models" },
    ...(account?.role === "admin"
      ? [{ key: "admin", label: "管理", icon: "admin", view: "admin" as View }]
      : []),
    { key: "audio", label: "音频", icon: "audio", view: "audio" },
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
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">
          To<span className="mark">IV</span>
          <span className="sub">极光 · AI 创作平台</span>
        </span>

        <nav className="modal-nav" aria-label="模块导航">
          {navItems.map((m) => (
            <button
              key={m.key}
              type="button"
              className={view === m.view ? "active" : ""}
              onClick={() => setView(m.view)}
              aria-current={view === m.view ? "page" : undefined}
            >
              <NavIcon name={m.icon} />
              {m.label}
            </button>
          ))}
        </nav>

        <div className="account">
          <span className="user-chip" title={account?.email}>
            {account?.email}
            <em>{account?.usageTotal ?? 0} 次生成</em>
          </span>
          <button type="button" className="logout" onClick={onLogout}>
            退出
          </button>
        </div>
      </header>

      {view === "assistant" ? (
        <div className="single-view">
          <AssistantView />
        </div>
      ) : view === "create" ? (
        <CreateStudio />
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
    </div>
  );
}
