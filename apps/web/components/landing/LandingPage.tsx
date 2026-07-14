"use client";

import { useState } from "react";

import { login, setToken } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";

/** 未登录落地页 —— 极简卡片式登录,靛蓝主题。 */
export function LandingPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token } = await login(email, password);
      if (token) {
        setToken(token);
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="landing">
      <div className="landing-card">
        <div className="landing-logo">
          <span className="landing-logo-dot" />
          <span className="landing-logo-text">ToIV</span>
        </div>
        <h1 className="landing-title">AI 创作平台</h1>
        <p className="landing-subtitle">由 ComfyUI 驱动的图像 / 视频 / 3D / 音频生成</p>

        <form className="landing-form" onSubmit={onSubmit}>
          <input
            type="text"
            className="input"
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
          <input
            type="password"
            className="input"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error && <div className="landing-error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? (
              <>
                <Icon name="loading" size={16} />
                登录中…
              </>
            ) : (
              "登录"
            )}
          </button>
        </form>

        <div className="landing-hint">
          默认管理员 <code>admin</code> / <code>admin123</code>
        </div>
      </div>

      <style jsx>{`
        .landing {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-4);
          background:
            radial-gradient(ellipse at 50% 0%, var(--accent-wash), transparent 60%),
            var(--bg-0);
        }
        .landing-card {
          width: 100%;
          max-width: 380px;
          padding: var(--space-6);
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-lg);
        }
        .landing-logo {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: var(--space-4);
        }
        .landing-logo-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 12px var(--accent);
        }
        .landing-logo-text {
          font-family: var(--font-display);
          font-size: 1.1rem;
          font-weight: 600;
          color: var(--ink);
          letter-spacing: -0.02em;
        }
        .landing-title {
          margin: 0 0 0.3rem;
          font-family: var(--font-display);
          font-size: 1.6rem;
          font-weight: 500;
          color: var(--ink);
          letter-spacing: -0.03em;
          line-height: 1.2;
        }
        .landing-subtitle {
          margin: 0 0 var(--space-5);
          font-size: 0.88rem;
          color: var(--ink-faint);
          line-height: 1.4;
        }
        .landing-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .landing-form .btn-primary {
          margin-top: var(--space-2);
        }
        .landing-error {
          padding: 0.5rem 0.7rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius-xs);
          color: var(--danger);
          font-size: 0.82rem;
        }
        .landing-hint {
          margin-top: var(--space-5);
          padding-top: var(--space-4);
          border-top: 1px solid var(--hairline);
          font-size: 0.78rem;
          color: var(--ink-faint);
          text-align: center;
        }
        .landing-hint code {
          font-family: var(--font-mono);
          color: var(--ink-soft);
          padding: 0.1rem 0.4rem;
          background: var(--bg-2);
          border-radius: var(--radius-xs);
          font-size: 0.78rem;
        }
      `}</style>
    </div>
  );
}
