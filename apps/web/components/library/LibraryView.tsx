"use client";

import { useEffect, useState } from "react";

import { imageUrl, listJobs } from "@/lib/api";
import type { JobItem } from "@/lib/types";

interface Asset {
  key: string;
  url: string;
  kind: string;
  prompt: string;
  seed: number;
}

const KIND_LABELS: Record<string, string> = {
  txt2img: "文生图",
  img2img: "图生图",
  wan_i2v: "视频",
  hunyuan3d: "3D",
  ace_step: "音乐",
  ace_audio: "音乐",
  agent_audio: "音乐",
  agent_image: "文生图",
  agent_img2img: "图生图",
  agent_video: "视频",
  agent_3d: "3D",
  agent_workflow: "工作流",
};

function assetType(url: string): "glb" | "audio" | "media" {
  const u = url.toLowerCase();
  if (u.includes(".glb")) return "glb";
  if (u.includes(".mp3") || u.includes(".flac") || u.includes(".wav") || u.includes(".ogg"))
    return "audio";
  return "media";
}

export function LibraryView() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Asset | null>(null);

  useEffect(() => {
    listJobs()
      .then((jobs: JobItem[]) => {
        const flat: Asset[] = [];
        for (const j of jobs) {
          (j.results ?? []).forEach((u, i) =>
            flat.push({
              key: `${j.id}-${i}`,
              url: imageUrl(u),
              kind: j.kind,
              prompt: j.prompt,
              seed: j.seed,
            }),
          );
        }
        setAssets(flat);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="modlib">
      <div className="stage-head">
        <h1>
          作品 <span className="grad">库</span>
        </h1>
        <span className="count">{assets?.length ?? 0} 件</span>
      </div>

      {error && <div className="alert">⚠ {error}</div>}

      {!assets ? (
        <p className="muted">加载中…</p>
      ) : assets.length === 0 ? (
        <div className="hero-canvas">
          <div className="hero-orb" aria-hidden="true" />
          <h2>还没有作品</h2>
          <p>去图像 / 视频 / 3D 模块创作,生成的作品会自动汇集到这里。</p>
        </div>
      ) : (
        <div className="gallery">
          {assets.map((a) => (
            <figure
              className="shot"
              key={a.key}
              onClick={() => assetType(a.url) === "media" && setActive(a)}
              style={assetType(a.url) === "glb" ? { cursor: "default" } : undefined}
            >
              {assetType(a.url) === "glb" ? (
                <a
                  className="glb-tile"
                  href={a.url}
                  download
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="glb-badge">3D · GLB</span>
                  <span className="glb-hint">下载模型</span>
                </a>
              ) : assetType(a.url) === "audio" ? (
                <div className="audio-tile" onClick={(e) => e.stopPropagation()}>
                  <span className="audio-badge">♪ 音乐</span>
                  <audio controls preload="none" src={a.url} />
                </div>
              ) : (
                <img src={a.url} alt={a.prompt} loading="lazy" />
              )}
              <figcaption className="meta">
                <span className="prompt" title={a.prompt}>
                  {a.prompt || "—"}
                </span>
                <span className="sub">
                  {KIND_LABELS[a.kind] ?? a.kind} · seed {a.seed}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {active && (
        <div className="lightbox" onClick={() => setActive(null)}>
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <img src={active.url} alt={active.prompt} />
            <div className="lightbox-meta">
              <p className="lb-prompt">{active.prompt || "—"}</p>
              <p className="lb-sub">
                {KIND_LABELS[active.kind] ?? active.kind} · seed {active.seed}
              </p>
              <div className="lb-actions">
                <a className="btn-ghost" href={active.url} download>
                  下载
                </a>
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
    </div>
  );
}
