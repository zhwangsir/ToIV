"use client";

import { useCallback, useMemo, useState } from "react";

import { imageUrl } from "@/lib/api";
import type { DramaShotItem } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { shotStatusMeta } from "@/components/drama-studio/ShotCard";

interface FilmstripTimelineProps {
  shots: DramaShotItem[];
  selectedShotId: string | null;
  onSelectShot: (sid: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

function getThumbSource(
  shot: DramaShotItem,
): { type: "image" | "video"; url: string } | null {
  if (shot.keyframe_url) return { type: "image", url: shot.keyframe_url };
  if (shot.video_url) return { type: "video", url: shot.video_url };
  if (shot.lipsync_video_url)
    return { type: "video", url: shot.lipsync_video_url };
  return null;
}

function dialogueClip(text: string, max = 20): string {
  if (!text) return "";
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const meta = shotStatusMeta(status);
  return (
    <span className={`ds-badge-status ${meta.cls}`} title={`${label}: ${meta.label}`}>
      <Icon
        name={meta.icon}
        size={9}
        strokeWidth={1.9}
        className={meta.icon === "loading" ? "ds-spin" : undefined}
      />
      <span className="ds-badge-label">{label}</span>
      <span className="ds-badge-text">{meta.label}</span>
    </span>
  );
}

function ShotThumb({ shot }: { shot: DramaShotItem }) {
  const src = getThumbSource(shot);
  if (!src) {
    return (
      <div className="ft-thumb ft-thumb-empty">
        <Icon name="image" size={18} strokeWidth={1.4} />
      </div>
    );
  }
  if (src.type === "image") {
    return (
      <div className="ft-thumb">
        <img src={imageUrl(src.url)} alt={`分镜 ${shot.idx}`} loading="lazy" />
      </div>
    );
  }
  return (
    <div className="ft-thumb">
      <video src={imageUrl(src.url)} preload="metadata" playsInline muted />
      <span className="ft-dur">{shot.duration_sec || 0}s</span>
    </div>
  );
}

export function FilmstripTimeline({
  shots,
  selectedShotId,
  onSelectShot,
  collapsed,
  onToggleCollapse,
}: FilmstripTimelineProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = collapsed !== undefined ? collapsed : internalCollapsed;

  const toggle = useCallback(() => {
    if (onToggleCollapse) {
      onToggleCollapse();
    } else {
      setInternalCollapsed((v) => !v);
    }
  }, [onToggleCollapse]);

  const currentShot = useMemo(
    () => shots.find((s) => s.id === selectedShotId) ?? shots[0],
    [shots, selectedShotId],
  );

  const totalDuration = useMemo(
    () => shots.reduce((a, s) => a + (s.duration_sec || 0), 0),
    [shots],
  );

  return (
    <section className={`filmstrip ${isCollapsed ? "collapsed" : ""}`} aria-label="分镜时间线">
      <div className="filmstrip-head">
        <button
          type="button"
          className="filmstrip-toggle"
          title={isCollapsed ? "展开时间线" : "收起时间线"}
          onClick={toggle}
          aria-expanded={!isCollapsed}
        >
          <Icon name={isCollapsed ? "chevron-up" : "chevron-down"} size={12} />
        </button>

        <div className="filmstrip-title">
          <Icon name="film" size={13} />
          <span>TIMELINE</span>
          <span className="tag">
            {shots.length} 镜 · {formatDuration(totalDuration)}
          </span>
        </div>

        {!isCollapsed && (
          <div className="timeline-ruler" aria-hidden="true">
            {[0, 10, 20, 30, 40, 50, 60].map((t) => (
              <span key={t} style={{ left: `${t * 6}px` }}>
                {t}s
              </span>
            ))}
          </div>
        )}

        {isCollapsed && currentShot && (
          <div className="filmstrip-current-mini">
            <span className="ft-mini-idx">#{currentShot.idx}</span>
            <span className="ft-mini-dialogue">
              {dialogueClip(currentShot.dialogue)}
            </span>
          </div>
        )}
      </div>

      {!isCollapsed && (
        <div className="filmstrip-body">
          {shots.map((shot) => {
            const active = selectedShotId === shot.id;
            return (
              <button
                key={shot.id}
                type="button"
                className={`film-cell ${active ? "active" : ""}`}
                onClick={() => onSelectShot(shot.id)}
                aria-pressed={active}
                title={`分镜 #${shot.idx}`}
              >
                <ShotThumb shot={shot} />
                <div className="f-meta">
                  <span className="f-idx">#{shot.idx}</span>
                  <span
                    className={`f-status ${shotStatusMeta(shot.video_status).cls.replace("ds-st-", "")}`}
                    aria-hidden="true"
                  />
                </div>
                <div className="ft-badges">
                  <StatusBadge status={shot.video_status} label="视频" />
                  <StatusBadge status={shot.voice_status} label="配音" />
                </div>
                {shot.dialogue && (
                  <p className="ft-dialogue">{dialogueClip(shot.dialogue)}</p>
                )}
              </button>
            );
          })}
        </div>
      )}

      <style jsx global>{`
        /* ── Filmstrip ── */
        .filmstrip {
          grid-area: filmstrip;
          position: relative;
          z-index: 2;
          display: flex;
          flex-direction: column;
          border-top: 1px solid var(--hairline);
          background: var(--bg-2);
          overflow: hidden;
        }
        .filmstrip.collapsed .filmstrip-head {
          border-bottom: none;
        }
        /* M4: 小屏(<900px)底部时间线变为抽屉,默认露出 48px 精简条,展开滑出 */
        @media (max-width: 900px) {
          .filmstrip {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 50;
            width: 100%;
            transform: translateY(calc(100% - 48px));
            transition: transform 0.25s ease;
            box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.25);
          }
          .filmstrip:not(.collapsed) {
            transform: translateY(0);
            max-height: 50vh;
            overflow-y: auto;
          }
          .filmstrip.collapsed .filmstrip-head {
            border-bottom: none;
          }
        }
        .filmstrip-toggle {
          display: grid;
          place-items: center;
          width: 20px;
          height: 20px;
          border: none;
          background: transparent;
          color: var(--ink3);
          cursor: pointer;
          border-radius: 4px;
          transition: all 0.15s ease;
          flex-shrink: 0;
        }
        .filmstrip-toggle:hover {
          background: var(--bg-3);
          color: var(--accent);
        }
        .filmstrip-head {
          display: flex;
          align-items: center;
          gap: 0.7rem;
          padding: 0.45rem 0.7rem;
          border-bottom: 1px solid var(--hairline);
          min-height: 40px;
        }
        .filmstrip-title {
          display: flex;
          align-items: center;
          gap: 0.45rem;
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--ink2);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          flex-shrink: 0;
        }
        .filmstrip-current-mini {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          min-width: 0;
          margin-left: auto;
          font-size: 0.72rem;
          color: var(--ink2);
        }
        .ft-mini-idx {
          flex-shrink: 0;
          font-weight: 700;
          color: var(--accent);
          font-family: var(--font-mono);
        }
        .ft-mini-dialogue {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .timeline-ruler {
          flex: 1;
          height: 18px;
          position: relative;
          background: repeating-linear-gradient(90deg, var(--hairline) 0 1px, transparent 1px 60px);
          margin: 0 0.5rem;
          min-width: 60px;
        }
        .timeline-ruler span {
          position: absolute;
          top: 2px;
          font-size: 0.6rem;
          color: var(--ink3);
          font-family: var(--font-mono);
        }
        .filmstrip-body {
          flex: 1;
          display: flex;
          gap: 0.5rem;
          padding: 0.55rem 0.7rem;
          overflow-x: auto;
          align-items: stretch;
          -webkit-overflow-scrolling: touch;
        }
        .film-cell {
          flex: 0 0 auto;
          width: 142px;
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          padding: 0;
          background: transparent;
          border: none;
          border-radius: var(--radius-sm);
          cursor: pointer;
          opacity: 0.75;
          text-align: left;
          transition: opacity 0.18s ease, background-color 0.18s ease;
        }
        .film-cell:hover {
          opacity: 1;
          background: var(--bg-3);
        }
        .film-cell.active {
          opacity: 1;
          background: var(--bg-3);
        }
        .film-cell.active .ft-thumb {
          border-color: var(--accent);
          box-shadow: 0 0 0 1px var(--accent);
        }
        .ft-thumb {
          aspect-ratio: 16/9;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          overflow: hidden;
          display: grid;
          place-items: center;
          color: var(--ink3);
          font-size: 0.7rem;
          position: relative;
        }
        .ft-thumb-empty {
          background: var(--bg-3);
        }
        .ft-thumb video,
        .ft-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .ft-dur {
          position: absolute;
          bottom: 0.25rem;
          right: 0.25rem;
          padding: 0.08rem 0.3rem;
          background: rgba(0, 0, 0, 0.7);
          border-radius: var(--radius-sm);
          font-size: 0.58rem;
          font-family: var(--font-mono);
          color: #fff;
        }
        .f-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 0.65rem;
          color: var(--ink3);
          font-family: var(--font-mono);
          padding: 0 0.1rem;
        }
        .f-idx {
          font-weight: 700;
          color: var(--accent);
        }
        .f-status {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--ink3);
        }
        .f-status.done {
          background: var(--color-success);
        }
        .f-status.run {
          background: var(--accent);
          box-shadow: 0 0 8px var(--accent);
        }
        .f-status.error {
          background: var(--danger);
        }
        .ft-badges {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          flex-wrap: wrap;
          padding: 0 0.1rem;
        }
        .ft-dialogue {
          margin: 0;
          padding: 0 0.1rem;
          font-size: 0.68rem;
          color: var(--ink2);
          line-height: 1.4;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* 状态徽章(与 ShotCard 共享语义) */
        .ds-badge-status {
          display: inline-flex;
          align-items: center;
          gap: 0.2rem;
          padding: 0.12rem 0.35rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          font-size: 0.6rem;
          color: var(--ink2);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .ds-badge-status .ds-badge-label {
          opacity: 0.8;
        }
        .ds-badge-status .ds-badge-text {
          font-weight: 700;
        }
        .ds-badge-status.ds-st-done {
          background: var(--success-quiet);
          border-color: color-mix(in srgb, var(--color-success) 35%, transparent);
          color: var(--color-success);
        }
        .ds-badge-status.ds-st-run {
          background: var(--warn-quiet);
          border-color: color-mix(in srgb, var(--color-warning) 35%, transparent);
          color: var(--color-warning);
        }
        .ds-badge-status.ds-st-err {
          background: var(--danger-quiet);
          border-color: color-mix(in srgb, var(--color-error) 35%, transparent);
          color: var(--color-error);
        }
        .ds-badge-status.ds-st-draft {
          background: var(--bg-3);
          border-color: var(--hairline);
          color: var(--ink3);
        }
      `}</style>
    </section>
  );
}
