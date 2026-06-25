"use client";

import "./showcase.css";

import { useEffect, useRef } from "react";

import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * /engine 落地页第二屏 —— 「六大创作能力」展示区。
 *
 * 复用 hero 的全息语言(等宽 kicker / 品紫口音 / glyph),但落到真实模块:
 * 每张卡直达 `/?view=<模块>`(由 app/page.tsx 的深链初始化接住)。
 * bento 编辑式布局:旗舰创作台占大格,漫剧次之,画布/3D/音频成行,模型市场横幅收尾。
 *
 * 入场:IntersectionObserver 命中即给区块挂 is-in,卡片靠 CSS 错峰上浮(--i 控制延迟)。
 * 动效只走 transform / opacity;reduced-motion → 无位移、瞬时显示。
 */

interface Capability {
  /** 深链目标:app/page.tsx View 值 */
  view: string;
  glyph: string;
  title: string;
  en: string;
  desc: string;
  tags: readonly string[];
  /** bento 跨度类 */
  span: "lg" | "md" | "sm" | "wide";
}

const CAPABILITIES: readonly Capability[] = [
  {
    view: "create",
    glyph: "◳",
    title: "创作台",
    en: "CREATE STUDIO",
    desc: "图像 / 视频 / 音频 / 3D 一站式出图。NoobAI v-pred 干净画风、ControlNet 构图控制、img2img 重绘,NSFW 档自由切换。",
    tags: ["txt2img", "v-pred", "ControlNet", "NSFW"],
    span: "lg",
  },
  {
    view: "manju",
    glyph: "❏",
    title: "漫剧导演台",
    en: "MANJU DIRECTOR",
    desc: "剧本 → 自动分镜 → 角色参考一致性出图 → 一键转视频。把一个故事拍成连续的镜头序列。",
    tags: ["分镜", "角色一致性", "转视频"],
    span: "md",
  },
  {
    view: "canvas",
    glyph: "⬡",
    title: "节点画布",
    en: "NODE CANVAS",
    desc: "自由编排的节点工作流,连线即管线,媒体优先的产物预览。",
    tags: ["工作流", "节点连线"],
    span: "sm",
  },
  {
    view: "threed",
    glyph: "◇",
    title: "3D 生成",
    en: "3D ASSETS",
    desc: "文本 / 图像 → GLB 三维资产,直接下载用于引擎与建模。",
    tags: ["text→3D", "GLB"],
    span: "sm",
  },
  {
    view: "audio",
    glyph: "≋",
    title: "音频工坊",
    en: "AUDIO FORGE",
    desc: "文本生成音乐与音效,为画面补上声音的维度。",
    tags: ["text→music", "SFX"],
    span: "sm",
  },
  {
    view: "models",
    glyph: "⬢",
    title: "模型市场",
    en: "MODEL MARKET",
    desc: "浏览与下载 checkpoint / LoRA / IPAdapter,落地到 GPU 集群即取即用。R18 真分区,内容随档可见。",
    tags: ["checkpoint", "LoRA", "下载落地", "R18 分区"],
    span: "wide",
  },
] as const;

export function CapabilityShowcase() {
  const reduced = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);

  // 进入视口即点亮;reduced-motion 直接常亮。
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    if (reduced) {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add("is-in");
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  return (
    <section id="capabilities" className="showcase" ref={sectionRef} aria-labelledby="showcase-title">
      <header className="showcase__head">
        <p className="showcase__kicker">
          <span className="showcase__kicker-tick" aria-hidden="true" />
          CAPABILITY MATRIX · 六大能力
        </p>
        <h2 id="showcase-title" className="showcase__title">
          一个引擎，<span className="showcase__title-accent">驱动全部创作</span>
        </h2>
        <p className="showcase__lede">
          由 4× RTX PRO 6000 的 ComfyUI 集群驱动 —— 从单张出图到连续漫剧、从三维资产到声音，
          全链路在同一控制台里完成。
        </p>
      </header>

      <div className="showcase__grid">
        {CAPABILITIES.map((c, i) => (
          <a
            key={c.view}
            href={`/?view=${c.view}`}
            className={`cap-card cap-card--${c.span}`}
            style={{ "--i": i } as React.CSSProperties}
          >
            <span className="cap-card__glyph" aria-hidden="true">
              {c.glyph}
            </span>
            <div className="cap-card__lead">
              <span className="cap-card__en">{c.en}</span>
              <h3 className="cap-card__title">{c.title}</h3>
            </div>
            <p className="cap-card__desc">{c.desc}</p>
            <ul className="cap-card__tags">
              {c.tags.map((t) => (
                <li key={t} className="cap-card__tag">
                  {t}
                </li>
              ))}
            </ul>
            <span className="cap-card__cta" aria-hidden="true">
              进入 <em>→</em>
            </span>
          </a>
        ))}
      </div>

      <footer className="showcase__foot">
        <a className="showcase__enter" href="/?view=create">
          立即进入控制台
          <span className="showcase__enter-arrow" aria-hidden="true">
            →
          </span>
        </a>
        <p className="showcase__note">无需配置环境，登录即用。</p>
      </footer>
    </section>
  );
}
