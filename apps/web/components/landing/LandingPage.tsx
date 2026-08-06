"use client";

import { useState } from "react";

import { login, setToken } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";

/** 三个能力关键词:纯排版展示(未登录态无作品数据,不拉接口)。 */
const CAPABILITIES = [
  { index: "01", label: "图像生成" },
  { index: "02", label: "视频生成" },
  { index: "03", label: "数字人对话" },
];

/**
 * 未登录落地页(批 3 剧场化)—— 走设计系统 v6 浅色五色板 token。
 * 版型:左 60% 品牌区(纸白底 + 全局噪点 + 大字标语 + 能力关键词),
 * 右 40% 登录玻璃卡;<1024px 退化为单列居中卡。
 * 样式全部在 app/styles/landing.css(styled-jsx 已清零)。
 */
export function LandingPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // 字段级错误:邮箱为空 / 密码为空 / 凭据错误(表单级)三类
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      setFormError(err instanceof Error ? err.message : "邮箱或密码错误,请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="landing">
      {/* ── 左:品牌区(大字标语 + 能力关键词,纯排版) ── */}
      <section className="landing-brand">
        <div className="landing-logo">
          <span className="landing-logo-dot" />
          <span className="landing-logo-text">ToIV</span>
        </div>
        <h1 className="landing-slogan">今天想创作什么?</h1>
        <p className="landing-brand-desc">
          一个工作台,装下图像、视频与数字人的完整创作流程。
        </p>
        <ul className="landing-keywords">
          {CAPABILITIES.map((c) => (
            <li key={c.index} className="landing-keyword">
              <span className="landing-keyword-index">{c.index}</span>
              <span className="landing-keyword-label">{c.label}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 右:登录玻璃卡 ── */}
      <section className="landing-auth">
        <div className="landing-card">
          {/* 移动端品牌头(<1024 品牌区隐藏,卡内补 compact 品牌行) */}
          <div className="landing-card-brand">
            <span className="landing-logo-dot" />
            <span className="landing-logo-text">ToIV</span>
          </div>
          <h2 className="landing-title">登录</h2>
          <p className="landing-subtitle">AI 创作平台 · 图像 / 视频 / 音频 / 数字人</p>

          <form className="landing-form" onSubmit={onSubmit} noValidate>
            <div className="landing-field">
              <input
                type="text"
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
      </section>
    </div>
  );
}
