"use client";

/**
 * LibTV 式短剧工作台 —— 右栏检查器(Team C)。
 *
 * 三态(设计文档 2.6):
 *   选中镜头 → 镜头摘要(镜号/状态/时长/mood/beat/描述截断 +「在短片页打开」)
 *   选中角色 → 角色摘要(三视图正面/描述/被引用镜数,可跳回镜头)
 *   未选中   → 项目摘要(进度环/镜数/预计总时长/状态 + 角色速览)
 * 角色选中:外部受控(selectedCharacterId)优先,否则内部自管理。
 */
import { useState } from "react";

import { imageUrl } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { InspectorProps } from "./types";
import { ShotStatusBadge } from "./ShotTableRow";

function fmtTotal(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 项目进度环(SVG,stroke 走 --wb-* token) */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const frac = total > 0 ? done / total : 0;
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className="wb-ring"
      width="72"
      height="72"
      viewBox="0 0 72 72"
      role="img"
      aria-label={`进度 ${Math.round(frac * 100)}%`}
    >
      <circle className="wb-ring-bg" cx="36" cy="36" r={r} />
      <circle
        className="wb-ring-fg"
        cx="36"
        cy="36"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        transform="rotate(-90 36 36)"
      />
      <text className="wb-ring-text" x="36" y="40" textAnchor="middle">
        {Math.round(frac * 100)}%
      </text>
    </svg>
  );
}

export function Inspector({ dp, onOpenProduce, selectedCharacterId }: InspectorProps) {
  const [localCharId, setLocalCharId] = useState<string | null>(null);
  const shot = dp.selectedShot;
  const charId = selectedCharacterId ?? localCharId;
  const character = dp.characters.find((c) => c.id === charId) ?? null;
  const totalSec = dp.shots.reduce((acc, s) => acc + (s.duration_sec || 0), 0);

  /* ── 镜头摘要 ── */
  if (shot) {
    return (
      <div className="wb-inspect">
        <div className="wb-inspector-head">
          <span>镜头 #{shot.idx}</span>
          <ShotStatusBadge status={shot.video_status} error={shot.error} />
        </div>
        <dl>
          <div className="wb-inspect-kv">
            <dt>场次</dt>
            <dd>{shot.scene || "—"}</dd>
          </div>
          <div className="wb-inspect-kv">
            <dt>时长</dt>
            <dd>{(shot.duration_sec || 0).toFixed(1)}s</dd>
          </div>
          <div className="wb-inspect-kv">
            <dt>情绪标签</dt>
            <dd>{shot.mood || "—"}</dd>
          </div>
          <div className="wb-inspect-kv">
            <dt>节拍注记</dt>
            <dd>{shot.beat || "—"}</dd>
          </div>
        </dl>
        <p className="wb-inspect-desc" title={shot.prompt}>
          {shot.prompt || "(无描述)"}
        </p>
        {(shot.characters ?? []).length > 0 && (
          <div className="wb-inspect-chips">
            {(shot.characters ?? []).map((name) => (
              <span key={name} className="wb-chip">
                {name}
              </span>
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm wb-inspect-cta"
          onClick={() => onOpenProduce(shot.id)}
        >
          <Icon name="film" size={13} />
          在短片页打开
        </button>
      </div>
    );
  }

  /* ── 角色摘要 ── */
  if (character) {
    const refShots = dp.shots.filter((s) =>
      (s.characters ?? []).includes(character.name),
    );
    return (
      <div className="wb-inspect">
        <div className="wb-inspector-head">
          <span>角色</span>
          {selectedCharacterId === undefined && (
            <button
              type="button"
              className="wb-icon-text-btn"
              onClick={() => setLocalCharId(null)}
            >
              返回项目摘要
            </button>
          )}
        </div>
        <div className="wb-inspect-char">
          {character.reference_front ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="wb-inspect-char-img"
              src={imageUrl(character.reference_front)}
              alt={character.name}
              width={64}
              height={64}
            />
          ) : (
            <span className="wb-inspect-char-img wb-avatar-ph">
              {character.name.slice(0, 1)}
            </span>
          )}
          <div className="wb-inspect-char-name">{character.name}</div>
        </div>
        <p className="wb-inspect-desc" title={character.description}>
          {character.description || "(无描述)"}
        </p>
        <dl>
          <div className="wb-inspect-kv">
            <dt>被引用</dt>
            <dd>{refShots.length} 镜</dd>
          </div>
        </dl>
        {refShots.length > 0 && (
          <div className="wb-inspect-chips">
            {refShots.map((s) => (
              <button
                key={s.id}
                type="button"
                className="wb-chip wb-chip-btn"
                title={`定位到镜头 #${s.idx}`}
                onClick={() => dp.setSelectedShotId(s.id)}
              >
                #{s.idx}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ── 项目摘要 ── */
  const modelLabel =
    dp.videoGenerators.find((g) => g.name === dp.videoModel)?.display_name ||
    dp.videoModel;
  return (
    <div className="wb-inspect">
      <div className="wb-inspector-head">
        <span>项目摘要</span>
      </div>
      <div className="wb-inspect-ring">
        <ProgressRing done={dp.doneCount} total={dp.shots.length} />
      </div>
      <dl>
        <div className="wb-inspect-kv">
          <dt>镜数</dt>
          <dd>{dp.shots.length}</dd>
        </div>
        <div className="wb-inspect-kv">
          <dt>已完成</dt>
          <dd>{dp.doneCount}</dd>
        </div>
        <div className="wb-inspect-kv">
          <dt>预计总时长</dt>
          <dd>{fmtTotal(totalSec)}</dd>
        </div>
        <div className="wb-inspect-kv">
          <dt>状态</dt>
          <dd>{dp.current?.status ?? "—"}</dd>
        </div>
        <div className="wb-inspect-kv">
          <dt>生成模型</dt>
          <dd>{modelLabel}</dd>
        </div>
        <div className="wb-inspect-kv">
          <dt>角色</dt>
          <dd>{dp.characters.length}</dd>
        </div>
      </dl>
      {dp.characters.length > 0 && (
        <div className="wb-inspect-chips">
          {dp.characters.map((c) => (
            <button
              key={c.id}
              type="button"
              className="wb-chip wb-chip-btn"
              title={`查看角色「${c.name}」`}
              onClick={() => setLocalCharId(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
