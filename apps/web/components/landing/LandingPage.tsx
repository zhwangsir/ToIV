"use client";

import Link from "next/link";

import "./landing.css";

/** 四大旗舰模块(编号卡,承接首页 → /login → 对应视图深链)。 */
const FEATURES = [
  {
    no: "01",
    view: "manju",
    title: "漫剧工坊",
    desc: "一句话拆分镜、生成角色、逐镜配音、一键成片 —— 从灵感到 AI 短剧,全流程一站式。",
    icon: (
      <path d="M4 5h16v14H4zM4 9h16M9 5v4M15 5v4M9 19v-4M15 19v-4" />
    ),
  },
  {
    no: "02",
    view: "dub",
    title: "视频译制",
    desc: "已有长视频自动剪辑 + 多语言克隆配音 + 对口型,中英日韩四语言成片,内容出海即刻。",
    icon: <path d="M3 8v8h4l5 4V4L7 8H3zM16 9a3 3 0 0 1 0 6M19 6a7 7 0 0 1 0 12" />,
  },
  {
    no: "03",
    view: "canvas",
    title: "无限画布",
    desc: "节点式自由编排:文生图、改图、放大、局部重绘、转视频 —— 像搭积木一样组合创作。",
    icon: (
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6zM10 7h4M7 10v4M17 10v4M10 17h4" />
    ),
  },
  {
    no: "04",
    view: "assistant",
    title: "意图创作",
    desc: "图像 / 视频 / 3D / 音乐,同一个创作台。用自然语言说出需求,AI 自动选模型、跑工作流、出结果。",
    icon: (
      <path d="M12 3l2.09 4.26L19 8l-3.5 3.4.83 4.85L12 14l-4.33 2.25.83-4.85L5 8l4.91-.74z" />
    ),
  },
] as const;

/** 底层能力矩阵(与真实后端对应)。 */
const CAPS = [
  {
    title: "智能对话",
    models: "多模型自由切换 · 自动编排工作流",
    icon: <path d="M4 5h16v11H9l-5 4V5z" />,
  },
  {
    title: "图像创作",
    models: "ComfyUI ⇄ Forge 双引擎 · FLUX.2 / Qwen / SDXL",
    icon: <path d="M4 5h16v14H4zM4 15l4-4 3 3 4-5 5 6" />,
  },
  {
    title: "视频生成",
    models: "Wan 2.2 图生 / 文生视频 · 运镜与对口型",
    icon: <path d="M3 6h13v12H3zM16 10l5-3v10l-5-3z" />,
  },
  {
    title: "语音合成",
    models: "IndexTTS2 音色克隆 · ACE-Step AI 配乐",
    icon: <path d="M12 3v13M12 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 5l7-2v11" />,
  },
] as const;

const STATS = [
  { n: "8", l: "创作模块" },
  { n: "4×", l: "GPU 并行" },
  { n: "∞", l: "创造力" },
] as const;

function IconBox({ children }: { children: React.ReactNode }) {
  return (
    <span className="lp-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

export function LandingPage() {
  return (
    <div className="lp">
      {/* 宇宙背景层:渐晕 + 星场 + 地平弧 + 光束(纯 CSS,不动布局) */}
      <div className="lp-cosmos" aria-hidden="true">
        <div className="lp-glow lp-glow--top" />
        <div className="lp-stars" />
        <div className="lp-horizon" />
        <div className="lp-beam lp-beam--a" />
        <div className="lp-beam lp-beam--b" />
      </div>

      <header className="lp-nav">
        <div className="lp-brand">
          To<span className="mark">IV</span>
        </div>
        <nav className="lp-nav-actions" aria-label="主导航">
          <Link className="lp-nav-link" href="/login">
            登录
          </Link>
          <Link className="lp-cta lp-cta--sm" href="/login">
            开始创作 <span aria-hidden="true">→</span>
          </Link>
        </nav>
      </header>

      <main>
        {/* ---------- Hero ---------- */}
        <section className="lp-hero">
          <span className="lp-eyebrow lp-eyebrow--dot">意图驱动 · 新一代 AIGC 平台</span>
          <h1 className="lp-title">
            一句话，<span className="lp-title-accent">造一个世界</span>
          </h1>
          <p className="lp-lede">
            图像 · 视频 · 3D · 音乐,同一个创作台。<br />
            不必懂参数、不必选模型 —— 说出想要的画面,AI 自动跑通全流程。
          </p>
          <div className="lp-hero-actions">
            <Link className="lp-cta" href="/login">
              开始创作 <span aria-hidden="true">→</span>
            </Link>
            <a className="lp-cta lp-cta--ghost" href="#features">
              了解能力
            </a>
          </div>
          <dl className="lp-stats">
            {STATS.map((s) => (
              <div className="lp-stat" key={s.l}>
                <dt className="lp-stat-n">{s.n}</dt>
                <dd className="lp-stat-l">{s.l}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ---------- 四大旗舰模块 ---------- */}
        <section className="lp-section" id="features">
          <span className="lp-eyebrow">AI STUDIO</span>
          <h2 className="lp-h2">
            不只是工具，<span className="lp-title-accent">是你的创作搭档</span>
          </h2>
          <p className="lp-sub">从文案到成片、从灵感到落地 —— 一条龙 AI 工作流,效率提升 10 倍。</p>
          <div className="lp-grid">
            {FEATURES.map((f) => (
              <Link className="lp-card" key={f.no} href={`/login?next=${f.view}`}>
                <span className="lp-card-no" aria-hidden="true">
                  {f.no}
                </span>
                <IconBox>{f.icon}</IconBox>
                <h3 className="lp-card-title">{f.title}</h3>
                <p className="lp-card-desc">{f.desc}</p>
                <span className="lp-card-link">
                  立即体验 <span aria-hidden="true">→</span>
                </span>
              </Link>
            ))}
          </div>
        </section>

        {/* ---------- 底层能力矩阵 ---------- */}
        <section className="lp-section">
          <span className="lp-eyebrow">PLATFORM</span>
          <h2 className="lp-h2">
            四大核心能力，<span className="lp-title-accent">一个平台</span>
          </h2>
          <p className="lp-sub">自托管多卡集群驱动,模型与工作流全部在自己的机器上跑。</p>
          <div className="lp-grid lp-grid--caps">
            {CAPS.map((c) => (
              <div className="lp-cap" key={c.title}>
                <IconBox>{c.icon}</IconBox>
                <h3 className="lp-card-title">{c.title}</h3>
                <p className="lp-cap-models">{c.models}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------- 结尾 CTA ---------- */}
        <section className="lp-final">
          <div className="lp-final-inner">
            <h2 className="lp-h2">准备好造你的世界了吗？</h2>
            <p className="lp-sub">登录即用,无需配置环境。</p>
            <Link className="lp-cta lp-cta--lg" href="/login">
              进入创作台 <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span className="lp-brand lp-brand--sm">
          To<span className="mark">IV</span>
        </span>
        <span className="lp-footer-note">意图驱动 AIGC 创作平台 · 账号由管理员统一发放</span>
      </footer>
    </div>
  );
}
