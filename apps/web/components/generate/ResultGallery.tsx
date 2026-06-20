import type { GenResult } from "@/lib/types";

interface Props {
  results: GenResult[];
}

export function ResultGallery({ results }: Props) {
  if (results.length === 0) {
    return (
      <div className="empty-canvas">
        还没有作品。在左侧输入提示词，点击「生成」即可由你的 ComfyUI 出图。
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
