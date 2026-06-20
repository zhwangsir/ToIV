"use client";

import { useState } from "react";

import { login, register, setToken } from "@/lib/api";
import type { AuthResult } from "@/lib/api";

interface Props {
  onAuthed: (result: AuthResult) => void;
}

export function AuthScreen({ onAuthed }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const fn = mode === "login" ? login : register;
      const result = await fn(email.trim(), password);
      setToken(result.token);
      onAuthed(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand auth-brand">
          To<span className="mark">IV</span>
        </div>
        <p className="auth-tagline">极光 · AI 创作平台</p>

        <div className="auth-tabs">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            注册
          </button>
        </div>

        <form onSubmit={submit} className="auth-form">
          <div className="field">
            <label htmlFor="email">邮箱</label>
            <input
              id="email"
              type="text"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "register" ? "至少 6 位" : "••••••••"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <div className="alert">⚠ {error}</div>}

          <button
            type="submit"
            className="generate-btn"
            disabled={busy || !email.trim() || password.length < 6}
          >
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并进入"}
          </button>
        </form>

        <p className="auth-switch">
          {mode === "login" ? "还没有账号？" : "已有账号？"}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "去注册" : "去登录"}
          </button>
        </p>
      </div>
    </div>
  );
}
