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
            radial-gradient(ellipse at 50% 0%, rgba(124, 108, 255, 0.08), transparent 60%),
            var(--bg-canvas);
        }
        .landing-card {
          width: 100%;
          max-width: 380px;
          padding: var(--space-6);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          box-shadow: var(--shadow-xl);
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
          box-shadow: 0 0 12px var(--accent-glow);
        }
        .landing-logo-text {
          font-size: var(--text-section);
          font-weight: 700;
          color: var(--text-primary);
          letter-spacing: -0.02em;
        }
        .landing-title {
          margin: 0 0 0.3rem;
          font-size: var(--text-title);
          font-weight: 700;
          color: var(--text-primary);
          letter-spacing: -0.02em;
          line-height: 1.3;
        }
        .landing-subtitle {
          margin: 0 0 var(--space-5);
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.6;
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
          background: var(--err-soft);
          border: 1px solid var(--err);
          border-radius: var(--radius-control);
          color: var(--err);
          font-size: var(--text-aux);
        }
        .landing-hint {
          margin-top: var(--space-5);
          padding-top: var(--space-4);
          border-top: 1px solid var(--border-subtle);
          font-size: var(--text-aux);
          color: var(--text-muted);
          text-align: center;
        }
        .landing-hint code {
          font-family: var(--font-mono);
          color: var(--text-secondary);
          padding: 0.1rem 0.4rem;
          background: var(--bg-surface-3);
          border-radius: var(--radius-sm);
          font-size: var(--text-aux);
        }
      `}</style>
    </div>
  );
}
