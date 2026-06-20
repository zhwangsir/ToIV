import type { GenResult } from "@/lib/types";

interface Props {
  results: GenResult[];
}

export function ResultGallery({ results }: Props) {
  if (results.length === 0) {
    return (
      <div className="hero-canvas">
        <div className="hero-orb" aria-hidden="true" />
        <h2>把想象渲染成画面</h2>
        <p>
          在左侧描述你想要的画面，点击「生成」，由你的 ComfyUI 集群即时出图。
          视频、3D、音频模态即将上线。
        </p>
      </div>
    );
  }

  return (
    <div className="gallery">
      {results.map((r) => (
        <figure className="shot" key={r.id}>
          <img src={r.url} alt={r.prompt} loading="lazy" width={512} height={512} />
          <figcaption className="meta">
            <span className="prompt" title={r.prompt}>
              {r.prompt}
            </span>
            <span className="sub">
              {r.ckpt.replace(/\.safetensors$/, "")} · seed {r.seed}
            </span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
