"use client";

import type { ShotCard as ShotCardModel } from "./types";

interface ShotCardProps {
  shot: ShotCardModel;
  index: number;
  selected: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onImage: (id: string) => void;
  onVideo: (id: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  imaging: "出图中…",
  error: "出错",
};

/** 单张分镜卡:缩略图 + 镜号 + 角色标签 + 运镜 + 台词 + 状态。 */
export function ShotCard({
  shot,
  index,
  selected,
  busy,
  onSelect,
  onImage,
  onVideo,
}: ShotCardProps) {
  const statusLabel = STATUS_LABEL[shot.status];

  return (
    <article
      className={`manju-shot${selected ? " is-selected" : ""}`}
      onClick={() => onSelect(shot.id)}
      aria-current={selected ? "true" : undefined}
    >
      <div className="manju-shot-thumb">
        {shot.imageUrl ? (
          <img src={shot.imageUrl} alt={`镜 ${index + 1}`} loading="lazy" />
        ) : (
          <div className="manju-shot-empty" aria-hidden="true">
            <span className="manju-shot-no">{String(index + 1).padStart(2, "0")}</span>
          </div>
        )}
        {shot.status === "imaging" && <div className="manju-shot-spinner" aria-label="出图中" />}
        {statusLabel && shot.status !== "imaging" && (
          <span className={`manju-shot-badge st-${shot.status}`}>{statusLabel}</span>
        )}
        {shot.status === "video" && <span className="manju-shot-badge st-video">▶ 视频</span>}
      </div>

      <div className="manju-shot-body">
        <header className="manju-shot-head">
          <span className="manju-shot-id">镜 {index + 1}</span>
          {shot.camera && <span className="manju-shot-cam">{shot.camera}</span>}
          <span className="manju-shot-dur">{shot.duration_sec}s</span>
        </header>

        {shot.characters.length > 0 && (
          <div className="manju-shot-chars">
            {shot.characters.map((c) => (
              <span className="manju-char-tag" key={c}>
                {c}
              </span>
            ))}
          </div>
        )}

        {shot.dialogue && <p className="manju-shot-line">「{shot.dialogue}」</p>}

        <div className="manju-shot-actions">
          <button
            type="button"
            disabled={busy || shot.status === "imaging"}
            onClick={(e) => {
              e.stopPropagation();
              onImage(shot.id);
            }}
          >
            {shot.imageUrl ? "重出图" : "出图"}
          </button>
          <button
            type="button"
            disabled={busy || !shot.imageUrl}
            onClick={(e) => {
              e.stopPropagation();
              onVideo(shot.id);
            }}
            title={shot.imageUrl ? "用本镜关键帧生成视频" : "先出图再转视频"}
          >
            转视频
          </button>
        </div>
        {shot.error && <p className="manju-shot-err">⚠ {shot.error}</p>}
      </div>
    </article>
  );
}
