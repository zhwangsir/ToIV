"use client";

import { useState } from "react";

import type { GenResult } from "@/lib/types";

interface Props {
  results: GenResult[];
  onExample: (prompt: string) => void;
  loading?: boolean;
}

const EXAMPLES = [
  "赛博朋克夜景城市，霓虹倒影，电影质感",
  "梦幻森林，发光蘑菇，丁达尔光，唯美",
  "日式庭园，红枫，锦鲤池，晨雾",
  "宇航员漂浮在绚丽星云中，超现实",
];

function shortModel(ckpt: string): string {
  return ckpt.replace(/\.safetensors$/, "");
}

export function ResultGallery({ results, onExample, loading = false }: Props) {
  const [active, setActive] = useState<GenResult | null>(null);

  if (results.length === 0 && !loading) {
    return (
      <div className="hero-canvas">
        <div className="hero-orb" aria-hidden="true" />
        <h2>把想象渲染成画面</h2>
        <p>
          描述你想要的画面，点击「生成」，由你的 ComfyUI 集群即时出图。
          视频、3D、音频模态即将上线。
        </p>
        <div className="example-chips">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" className="chip" onClick={() => onExample(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="gallery">
        {loading && <div className="skel-tile" aria-label="生成中" />}
        {results.map((r) => (
          <figure className="shot" key={r.id} onClick={() => setActive(r)}>
            <img src={r.url} alt={r.prompt} loading="lazy" width={512} height={512} />
            <div className="shot-overlay">
              <a
                className="icon-btn"
                href={r.url}
                download
                title="下载"
                aria-label="下载"
                onClick={(e) => e.stopPropagation()}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
            </div>
            <figcaption className="meta">
              <span className="prompt" title={r.prompt}>
                {r.prompt}
              </span>
              <span className="sub">
                {shortModel(r.ckpt)} · seed {r.seed}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>

      {active && (
        <div className="lightbox" onClick={() => setActive(null)}>
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <img src={active.url} alt={active.prompt} />
            <div className="lightbox-meta">
              <p className="lb-prompt">{active.prompt}</p>
              <p className="lb-sub">
                {shortModel(active.ckpt)} · seed {active.seed}
              </p>
              <div className="lb-actions">
                <a className="btn-ghost" href={active.url} download>
                  下载原图
                </a>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    onExample(active.prompt);
                    setActive(null);
                  }}
                >
                  用此提示词重绘
                </button>
              </div>
            </div>
            <button
              type="button"
              className="lightbox-close"
              onClick={() => setActive(null)}
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  );
}
