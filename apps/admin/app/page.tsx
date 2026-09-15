"use client";

import { useCallback, useEffect, useState } from "react";

import { AppsManager } from "@/components/AppsManager";
import { Dashboard } from "@/components/Dashboard";
import { SystemJobs } from "@/components/SystemJobs";
import { getToken, login as apiLogin, me, setToken, type Me } from "@/lib/api";

type TabKey = "dash" | "apps" | "sysjobs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "dash", label: "概览" },
  { key: "apps", label: "应用管理" },
  { key: "sysjobs", label: "系统任务" },
];

export default function Page() {
  const [account, setAccount] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("admin");
  const [password, setPassword] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [tab, setTab] = useState<TabKey>("dash");

  // 会话探测:已有 token 则校验角色(admin 专属控制台)
  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    me()
      .then((info) => {
        if (info.user?.role !== "admin") {
          setToken(null);
          setLoginErr("该账号不是管理员");
        } else {
          setAccount(info);
        }
      })
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginErr("");
    try {
      const token = await apiLogin(email, password);
      setToken(token);
      const info = await me();
      if (info.user?.role !== "admin") {
        setToken(null);
        setLoginErr("该账号不是管理员");
        return;
      }
      setAccount(info);
    } catch (err) {
      setLoginErr(err instanceof Error ? err.message : "登录失败");
    }
  };

  const logout = useCallback(() => {
    setToken(null);
    setAccount(null);
    setPassword("");
  }, []);

  if (checking) {
    return <div className="login-wrap muted">校验会话…</div>;
  }

  if (!account) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={handleLogin}>
          <h1>
            ToIV <em style={{ color: "var(--accent)", fontStyle: "normal" }}>管理系统</em>
          </h1>
          <div className="hint">独立管理控制台 · 仅管理员 · 内网访问</div>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="邮箱"
            autoComplete="username"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            autoComplete="current-password"
          />
          {loginErr && <div className="login-err">{loginErr}</div>}
          <button className="btn primary" type="submit">
            登录
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="shell-head">
        <span className="brand">
          ToIV <em>管理系统</em>
        </span>
        <nav className="tabs" aria-label="模块">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? "is-on" : ""}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="who">
          {account.user.email}
          <button className="link" style={{ marginLeft: 10 }} onClick={logout}>
            退出
          </button>
        </span>
      </header>
      <main className="shell-body">
        {tab === "dash" && <Dashboard />}
        {tab === "apps" && <AppsManager />}
        {tab === "sysjobs" && <SystemJobs />}
      </main>
    </div>
  );
}
