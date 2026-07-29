"use client";

import { imageUrl } from "@/lib/api";
import type { DramaShotItem } from "@/lib/api";
import { Icon, type IconName } from "@/components/ui/Icon";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface StoryboardGridProps {
  project: UseDramaProjectReturn;
}

type ShotStatus = "draft" | "generating" | "done" | "error";

// 单镜视频状态归一:busyShot(已提交未回写)也按生成中处理
function statusOf(shot: DramaShotItem, busy: boolean): ShotStatus {
  const s = (shot.video_status || "").toLowerCase();
  if (s === "done" || s === "ready" || s === "completed") return "done";
  if (s === "error" || s === "failed") return "error";
  if (busy || s === "generating" || s === "running" || s === "processing")
    return "generating";
  return "draft";
}

const STATUS_META: Record<ShotStatus, { icon: IconName; label: string }> = {
  draft: { icon: "queued", label: "待生成" },
  generating: { icon: "loading", label: "生成中" },
  done: { icon: "success", label: "已生成" },
  error: { icon: "error", label: "失败" },
};

/**
 * Film Atelier · 故事板网格(LibTV 核心对象)。
 * auto-fill 网格镜头卡:16:9 媒体区 + 编号/状态 + 场景/prompt/台词 + tags。
 * 点击卡片选中,联动右侧 ShotInspector。
 */
export function StoryboardGrid({ project }: StoryboardGridProps) {
  const {
    shots,
    busyShot,
    selectedShotId,
    setSelectedShotId,
    generateAllShots,
    pendingCount,
  } = project;

  return (
    <div className="fa-board-wrap">
      <div className="fa-board-head">
        <span className="fa-board-title">故事板</span>
        <span className="fa-board-tag">STORYBOARD · {shots.length} 镜</span>
        <button
          type="button"
          className="fa-btn fa-btn-sm"
          onClick={() => generateAllShots()}
          disabled={pendingCount === 0}
          title={
            pendingCount > 0
              ? `生成全部待出片分镜视频(剩余 ${pendingCount} 镜)`
              : "全部镜头均已出片"
          }
        >
          <Icon name="video" size={12} />
          生成全部视频{pendingCount > 0 ? ` · ${pendingCount}` : ""}
        </button>
      </div>

      {shots.length === 0 ? (
        <div className="fa-board-empty">
          <Icon name="film" size={28} strokeWidth={1.3} />
          <span>
            暂无分镜 · 在上方 Agent 条说「拆解剧本」或在剧本区手动拆分
          </span>
        </div>
      ) : (
        <div className="fa-board">
          {shots.map((shot) => {
            const st = statusOf(shot, busyShot === shot.id);
            const meta = STATUS_META[st];
            const selected = selectedShotId === shot.id;
            return (
              <article
                key={shot.id}
                className={`fa-shot fa-shot-${st} ${
                  selected ? "fa-shot-sel" : ""
                }`}
                onClick={() => setSelectedShotId(shot.id)}
                title={`#${shot.idx} ${shot.scene || "分镜"}`}
              >
                <div className="fa-shot-media">
                  {shot.video_url ? (
                    <video
                      src={imageUrl(shot.video_url)}
                      controls
                      playsInline
                      preload="metadata"
                      className="fa-shot-video"
                    />
                  ) : st === "generating" ? (
                    <div className="fa-shot-gen">
                      <Icon name="loading" size={22} className="fa-spin" />
                      <span>生成中</span>
                    </div>
                  ) : st === "error" ? (
                    <div className="fa-shot-errbox">
                      <Icon name="error" size={18} />
                      <span>{shot.error || "生成失败"}</span>
                    </div>
                  ) : (
                    <div className="fa-shot-draft">
                      <Icon name="film" size={26} strokeWidth={1.3} />
                    </div>
                  )}
                  {shot.duration_sec > 0 && (
                    <span className="fa-shot-dur">{shot.duration_sec}s</span>
                  )}
                </div>

                <div className="fa-shot-body">
                  <div className="fa-shot-top">
                    <span className="fa-shot-no">
                      {String(shot.idx).padStart(2, "0")}
                    </span>
                    <span className={`fa-badge fa-badge-${st}`}>
                      <Icon
                        name={meta.icon}
                        size={10}
                        className={
                          meta.icon === "loading" ? "fa-spin" : undefined
                        }
                      />
                      {meta.label}
                    </span>
                  </div>

                  <div className="fa-shot-scene" title={shot.scene}>
                    {shot.scene || `分镜 ${shot.idx}`}
                  </div>
                  {shot.prompt && (
                    <p className="fa-shot-prompt">{shot.prompt}</p>
                  )}
                  {shot.dialogue && (
                    <p className="fa-shot-dialogue">&ldquo;{shot.dialogue}&rdquo;</p>
                  )}

                  <div className="fa-shot-tags">
                    {shot.speaker && (
                      <span className="fa-shot-tag fa-shot-tag-speaker">
                        <Icon name="mic" size={9} />
                        {shot.speaker}
                      </span>
                    )}
                    {shot.duration_sec > 0 && (
                      <span className="fa-shot-tag">{shot.duration_sec}s</span>
                    )}
                    {shot.video_model && (
                      <span className="fa-shot-tag">{shot.video_model}</span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <style jsx>{`
        .fa-board-wrap {
          min-width: 0;
        }
        .fa-board-head {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 12px;
        }
        .fa-board-title {
          font-family: var(--fa-serif);
          font-size: 15px;
          font-weight: 600;
          color: var(--fa-ink);
        }
        .fa-board-tag {
          font-family: var(--fa-mono);
          font-size: 10px;
          letter-spacing: 0.1em;
          color: var(--fa-ink3);
        }
        .fa-board-head .fa-btn {
          margin-left: auto;
        }
        .fa-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border-radius: 6px;
          font-weight: 500;
          background: transparent;
          color: var(--fa-ink2);
          border: 1px solid var(--fa-line-hi);
          cursor: pointer;
          transition: all 0.2s ease;
          white-space: nowrap;
        }
        .fa-btn-sm {
          padding: 5px 11px;
          font-size: 11px;
        }
        .fa-btn:hover:not(:disabled) {
          color: var(--fa-ink);
          border-color: var(--fa-ink3);
          transform: translateY(-1px);
        }
        .fa-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .fa-board-empty {
          border: 1px dashed var(--fa-line-hi);
          border-radius: 10px;
          padding: 52px 20px;
          text-align: center;
          color: var(--fa-ink3);
          font-size: 12.5px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
        }
        .fa-board {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 14px;
        }
        .fa-shot {
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line);
          border-radius: 6px;
          overflow: hidden;
          cursor: pointer;
          transition: all 0.25s ease;
        }
        .fa-shot:hover {
          transform: translateY(-2px);
          border-color: var(--fa-line-hi);
        }
        .fa-shot-sel,
        .fa-shot-sel:hover {
          border-color: var(--fa-amber);
          box-shadow: 0 0 0 3px var(--fa-amber-soft);
        }
        .fa-shot-error,
        .fa-shot-error:hover {
          border-color: var(--fa-red);
        }
        .fa-shot-media {
          aspect-ratio: 16 / 9;
          position: relative;
          background: var(--fa-bg);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .fa-shot-video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .fa-shot-gen {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          color: var(--fa-amber);
          font-family: var(--fa-mono);
          font-size: 10px;
          letter-spacing: 0.14em;
          animation: fa-breathe 2s ease-in-out infinite;
        }
        .fa-shot-errbox {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          color: var(--fa-red);
          font-size: 11px;
          padding: 0 12px;
          text-align: center;
          line-height: 1.5;
        }
        .fa-shot-draft {
          color: var(--fa-ink3);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .fa-shot-dur {
          position: absolute;
          right: 8px;
          bottom: 7px;
          font-family: var(--fa-mono);
          font-size: 9px;
          color: var(--fa-ink2);
          background: var(--fa-bg);
          opacity: 0.85;
          padding: 2px 7px;
          border-radius: 3px;
        }
        .fa-shot-body {
          padding: 10px 12px 12px;
        }
        .fa-shot-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
        }
        .fa-shot-no {
          font-family: var(--fa-mono);
          font-size: 12px;
          letter-spacing: 0.08em;
          color: var(--fa-ink3);
        }
        .fa-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-family: var(--fa-mono);
          font-size: 9.5px;
          letter-spacing: 0.06em;
          padding: 2px 8px;
          border-radius: 3px;
          border: 1px solid var(--fa-line-hi);
        }
        .fa-badge-draft {
          color: var(--fa-ink3);
        }
        .fa-badge-generating {
          color: var(--fa-amber);
          border-color: var(--fa-amber-line);
          background: var(--fa-amber-soft);
        }
        .fa-badge-done {
          color: var(--fa-green);
        }
        .fa-badge-error {
          color: var(--fa-red);
          border-color: var(--fa-red);
        }
        .fa-shot-scene {
          font-family: var(--fa-serif);
          font-size: 14px;
          font-weight: 600;
          color: var(--fa-ink);
          line-height: 1.4;
          margin-bottom: 5px;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .fa-shot-prompt {
          font-family: var(--fa-mono);
          font-size: 10px;
          color: var(--fa-ink3);
          line-height: 1.55;
          margin-bottom: 6px;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .fa-shot-dialogue {
          font-style: italic;
          font-size: 11.5px;
          color: var(--fa-ink2);
          border-left: 2px solid var(--fa-amber);
          padding-left: 9px;
          margin-bottom: 8px;
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .fa-shot-tags {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .fa-shot-tag {
          font-family: var(--fa-mono);
          font-size: 9.5px;
          color: var(--fa-ink3);
          border: 1px solid var(--fa-line);
          border-radius: 3px;
          padding: 2px 7px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .fa-shot-tag-speaker {
          color: var(--fa-amber);
          border-color: var(--fa-amber-line);
        }
        .fa-spin {
          animation: fa-spin 1s linear infinite;
        }
        @keyframes fa-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes fa-breathe {
          0%,
          100% {
            opacity: 0.35;
          }
          50% {
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fa-spin,
          .fa-shot-gen {
            animation: none;
          }
          .fa-shot,
          .fa-btn {
            transition: none;
          }
          .fa-shot:hover {
            transform: none;
          }
        }
      `}</style>
    </div>
  );
}
