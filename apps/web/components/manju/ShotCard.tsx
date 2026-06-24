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
  imaging: "出图中",
  error: "出错",
};

/** 单张分镜卡:媒体优先 —— 产物铺满卡片当主体,镜号/状态/运镜收成卡底细带,悬停浮现。 */
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
  const no = String(index + 1).padStart(2, "0");
  const hasMedia = !!(shot.videoUrl || shot.imageUrl);

  return (
    <article
      className={`manju-shot${selected ? " is-selected" : ""}${hasMedia ? " has-media" : ""}`}
      onClick={() => onSelect(shot.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(shot.id);
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`镜 ${index + 1}${shot.camera ? " · " + shot.camera : ""}`}
    >
      {/* 媒体主体:铺满卡片,保原比例,衬底 --bg-sunken */}
      <div className="manju-shot-media">
        {shot.videoUrl ? (
          <video
            className="manju-shot-clip"
            src={shot.videoUrl}
            muted
            loop
            playsInline
            preload="metadata"
            onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
            onMouseLeave={(e) => {
              e.currentTarget.pause();
              e.currentTarget.currentTime = 0;
            }}
          />
        ) : shot.imageUrl ? (
          <img src={shot.imageUrl} alt={`镜 ${index + 1}`} loading="lazy" />
        ) : (
          <div className="manju-shot-empty" aria-hidden="true">
            <span className="manju-shot-no">{no}</span>
            <span className="manju-shot-empty-hint">待出图</span>
          </div>
        )}

        {shot.status === "imaging" && <div className="manju-shot-spinner" aria-label="出图中" />}

        {/* 角标:状态 / 视频标记,克制玻璃片 */}
        {shot.videoUrl && <span className="manju-shot-badge st-video">▶ 视频</span>}
        {statusLabel && shot.status !== "imaging" && (
          <span className={`manju-shot-badge st-${shot.status}`}>{statusLabel}</span>
        )}

        {/* 镜号细带:常驻底部,悬停升起完整信息 + 操作 */}
        <div className="manju-shot-band">
          <header className="manju-shot-band-head">
            <span className="manju-shot-no-chip">{no}</span>
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
        </div>
      </div>

      {shot.error && <p className="manju-shot-err">⚠ {shot.error}</p>}
    </article>
  );
}
