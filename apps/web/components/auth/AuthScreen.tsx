"use client";

import { useState } from "react";

import { login, setToken } from "@/lib/api";
import type { AuthResult } from "@/lib/api";

interface Props {
  onAuthed: (result: AuthResult) => void;
}

export function AuthScreen({ onAuthed }: Props) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(account.trim(), password);
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

        <form onSubmit={submit} className="auth-form">
          <div className="field">
            <label htmlFor="account">账号</label>
            <input
              id="account"
              type="text"
              autoComplete="username"
              placeholder="请输入账号"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <div className="alert">⚠ {error}</div>}

          <button
            type="submit"
            className="generate-btn"
            disabled={busy || account.trim().length < 3 || password.length < 6}
          >
            {busy ? "登录中…" : "登录"}
          </button>
        </form>

        <p className="auth-switch">账号由管理员统一发放,如需开通请联系管理员。</p>
      </div>
    </div>
  );
}
