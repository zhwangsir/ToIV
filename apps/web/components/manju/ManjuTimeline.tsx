"use client";

import { useState } from "react";

/** 时间线上的一镜:镜号 + 缩略 + 当前时长(秒)。顺序即成片顺序。 */
export interface TimelineClip {
  id: string;
  no: number;
  thumbUrl?: string;
  duration: number;
}

interface Props {
  clips: TimelineClip[];
  /** 拖拽重排:把 from 位的镜移到 to 位。 */
  onReorder: (from: number, to: number) => void;
  /** 调某镜时长(裁切到目标秒数)。 */
  onDuration: (id: string, duration: number) => void;
}

/**
 * 漫剧时间线编辑器(P1):横向轨道,块宽 ∝ 时长;拖拽重排顺序,点选某镜调时长。
 * 这是把漫剧从「分镜格子 + 一键拼接」升级成「真正能剪」的核心。
 */
export function ManjuTimeline({ clips, onReorder, onDuration }: Props) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [selId, setSelId] = useState<string | null>(null);

  const total = clips.reduce((a, c) => a + c.duration, 0);
  const sel = clips.find((c) => c.id === selId) ?? null;

  const commitDrop = (to: number) => {
    if (dragIdx !== null && dragIdx !== to) onReorder(dragIdx, to);
    setDragIdx(null);
    setOverIdx(null);
  };

  return (
    <div className="mtl">
      <div className="mtl-head">
        <span className="mtl-title">时间线</span>
        <span className="mtl-total">
          {clips.length} 镜 · 约 {total.toFixed(1)}s
        </span>
      </div>

      <div className="mtl-track">
        {clips.map((c, i) => (
          <div
            key={c.id}
            className={`mtl-clip${selId === c.id ? " is-sel" : ""}${overIdx === i ? " is-over" : ""}${dragIdx === i ? " is-drag" : ""}`}
            style={{ flexGrow: Math.max(0.6, c.duration) }}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIdx(i);
            }}
            onDragEnd={() => commitDrop(overIdx ?? i)}
            onDrop={(e) => {
              e.preventDefault();
              commitDrop(i);
            }}
            onClick={() => setSelId(c.id)}
            role="button"
            tabIndex={0}
            aria-label={`镜 ${c.no},${c.duration.toFixed(1)} 秒`}
            title={`镜 ${c.no} · ${c.duration.toFixed(1)}s`}
          >
            {c.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.thumbUrl} alt={`镜 ${c.no}`} loading="lazy" />
            ) : (
              <span className="mtl-no">{c.no}</span>
            )}
            <span className="mtl-clip-no">{c.no}</span>
            <span className="mtl-clip-dur">{c.duration.toFixed(1)}s</span>
          </div>
        ))}
      </div>

      {sel && (
        <div className="mtl-inspect">
          <span className="mtl-inspect-label">镜 {sel.no} 时长</span>
          <input
            type="range"
            min={0.5}
            max={6}
            step={0.5}
            value={sel.duration}
            onChange={(e) => onDuration(sel.id, parseFloat(e.target.value))}
            aria-label="镜头时长"
          />
          <span className="mtl-inspect-val">{sel.duration.toFixed(1)}s</span>
        </div>
      )}

      <p className="mtl-hint">拖拽缩略图重排顺序 · 点选某镜拖滑块调时长(裁切到目标时长)</p>
    </div>
  );
}
