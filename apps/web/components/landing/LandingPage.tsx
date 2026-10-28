"use client";

import { useEffect, useState } from "react";

import { login, setToken } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import "@/app/styles/landing.css";

/** 三个能力关键词:纯排版展示(未登录态无作品数据,不拉接口)。 */
const CAPABILITIES = [
  { index: "01", label: "分镜台", desc: "剧本拆镜 · 镜头表" },
  { index: "02", label: "成片轨", desc: "预览时间线 · 导出" },
  { index: "03", label: "素材池", desc: "镜头 / 音频 / 参考" },
];

/**
 * 未登录落地页 —— A3v2/A6 密台门（#0b0c0f / accent #4A7FC1）。
 * landing.css 仅 .landing；像「进工作室」而非 AI 海报；无粒子/玻璃/霓虹。
 * html data-mode=dark；登录成功整页 reload。
 */
export function LandingPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.mode = "dark";
    root.style.colorScheme = "dark";
    try {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", "#0b0c0f");
    } catch {
      /* ignore */
    }
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextEmailError = !email.trim() ? "请输入邮箱" : null;
    const nextPasswordError = !password ? "请输入密码" : null;
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setFormError(null);
    if (nextEmailError || nextPasswordError) return;
    setLoading(true);
    try {
      const { token } = await login(email.trim(), password);
      if (token) {
        setToken(token);
        window.location.reload();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      const isNetwork =
        err instanceof TypeError || msg.includes("请求超时") || msg.includes("网络");
      if (isNetwork) {
        setFormError("网络连接异常或请求超时,请检查网络后重试");
      } else if (msg.includes("账号或密码") || msg.includes("401")) {
        setFormError("账号或密码错误,请重试");
      } else {
        setFormError(msg || "登录失败,请重试");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="landing" data-landing-shell="dramaclaw-dark">
      <section className="landing-brand">
        <div className="landing-logo">
          <span className="landing-logo-dot" />
          <span className="landing-logo-text">ToIV</span>
        </div>
        <div className="landing-hero">
          <div className="landing-eyebrow">
            工具入口
          </div>
          <h1 className="landing-slogan">进入工作室</h1>
          <p className="landing-brand-desc">
            登录后进入密台：项目、分镜与成片轨。
          </p>
        </div>
        <ul className="landing-keywords">
          {CAPABILITIES.map((c) => (
            <li key={c.index} className="landing-keyword">
              <span className="landing-keyword-index">{c.index}</span>
              <span className="landing-keyword-label">{c.label}</span>
              <span className="landing-keyword-desc">{c.desc}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-auth">
        <div className="landing-card">
          <div className="landing-card-brand">
            <span className="landing-logo-dot" />
            <span className="landing-logo-text">ToIV</span>
          </div>
          <div className="landing-card-head">
            <h2 className="landing-title">登录</h2>
            <p className="landing-subtitle">账号登录 · 进入工作台</p>
          </div>

          <form className="landing-form" onSubmit={onSubmit} noValidate>
            <div className="landing-field">
              <input
                type="email"
                className="input"
                placeholder="邮箱"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                autoComplete="username"
                aria-invalid={!!emailError}
                aria-describedby={emailError ? "landing-email-error" : undefined}
              />
              {emailError && (
                <div id="landing-email-error" className="landing-field-error" role="alert">
                  {emailError}
                </div>
              )}
            </div>
            <div className="landing-field">
              <input
                type="password"
                className="input"
                placeholder="密码"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError) setPasswordError(null);
                }}
                autoComplete="current-password"
                aria-invalid={!!passwordError}
                aria-describedby={passwordError ? "landing-password-error" : undefined}
              />
              {passwordError && (
                <div id="landing-password-error" className="landing-field-error" role="alert">
                  {passwordError}
                </div>
              )}
            </div>
            {formError && (
              <div className="landing-error" role="alert">{formError}</div>
            )}
            <div className="landing-submit">
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? (
                  <>
                    <Icon name="loading" size={16} />
                    登录中…
                  </>
                ) : (
                  "进入工作室"
                )}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
