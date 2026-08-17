"use client";

/**
 * LibTV 式短剧工作台 —— 分镜表格行(阶段③,Team C)。
 *
 * 每行 = 一镜:镜号│资产(角色缩略圆片,hover 放大)│画面描述(截断,点击展开
 * 编辑 prompt + mood/beat)│故事板│状态(诚实降级徽章)│时长│操作(重生成换
 * seed/编辑/续写/口型)。展开态为紧随其后的整行编辑区(<tr> 双行结构)。
 * 交互语义搬自旧 DramaView ShotCard,视觉走 drama-workbench.css --wb-* 变量。
 */
import { useEffect, useRef, useState } from "react";

import { imageUrl, type DramaCharacterItem } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { DramaShotApi } from "./types";

/** 镜头状态四态:done/running/error/queued(与旧 StatusBadge 语义一致) */
export type ShotTone = "done" | "running" | "error" | "queued";

export function shotTone(status?: string): ShotTone {
  const st = (status || "").toLowerCase();
  if (st === "done" || st === "ready" || st === "completed") return "done";
  if (st === "error" || st === "failed") return "error";
  if (
    st === "generating" ||
    st === "continuing" ||
    st === "pending" ||
    st === "running"
  ) {
    return "running";
  }
  return "queued";
}

export const SHOT_TONE_LABEL: Record<ShotTone, string> = {
  done: "完成",
  running: "生成中",
  error: "失败",
  queued: "排队",
};

/** P1 衔接策略层:seam_to_next 四态短文案(空=未规划,不渲染徽章) */
export const SEAM_KIND_LABEL: Record<string, string> = {
  continue: "续写",
  overlap: "重叠",
  matchcut: "匹配",
  hardcut: "硬切",
};

/** 接缝选择器选项(值即后端枚举;空=未规划按硬切) */
export const SEAM_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "未规划(按硬切)" },
  { value: "continue", label: "续写(末帧续写)" },
  { value: "overlap", label: "重叠(共享帧叠化)" },
  { value: "matchcut", label: "匹配(图形匹配切口)" },
  { value: "hardcut", label: "硬切" },
];

/** matchcut/overlap 时显示锚点输入框 */
export function seamNeedsAnchor(seam: string): boolean {
  return seam === "matchcut" || seam === "overlap";
}

/** 状态徽章:error 走诚实降级徽章(图标+文案+原因 title),非裸红叉。 */
export function ShotStatusBadge({
  status,
  error,
  label,
}: {
  status?: string;
  error?: string;
  /** 前缀标签(如「配音」「口型」),与旧 StatusBadge 的 label·status 语义一致 */
  label?: string;
}) {
  const tone = shotTone(status);
  return (
    <span
      className={`wb-badge is-${tone}`}
      title={tone === "error" && error ? error : undefined}
    >
      {tone === "running" && <Icon name="refresh" size={11} />}
      {tone === "done" && <Icon name="check" size={11} />}
      {tone === "error" && <Icon name="warning" size={11} />}
      {tone === "queued" && <Icon name="queued" size={11} />}
      {label ? `${label}·` : ""}
      {SHOT_TONE_LABEL[tone]}
    </span>
  );
}

/** 行内编辑保存载荷(父组件负责补 dialogue/scene 后调 dp.saveShot) */
export interface ShotRowEditPatch {
  prompt: string;
  mood: string;
  beat: string;
  seam_to_next: string;
  seam_anchor: string;
}

export interface ShotTableRowProps {
  shot: DramaShotApi;
  selected: boolean;
  /** 项目角色列表(资产列把 shot.characters 名字解析成缩略圆片) */
  characters: DramaCharacterItem[];
  busyVideo: boolean;
  busyContinue: boolean;
  busyLipsync: boolean;
  onSelect: () => void;
  onOpenProduce: (sid: string) => void;
  onSave: (patch: ShotRowEditPatch) => void;
  /** 重生成(换 seed,父组件注入) */
  onRegenerate: () => void;
  onContinue: () => void;
  onLipsync: () => void;
  /** 故事板缺图时的「生成故事板」(父组件路由到宫格分镜流程) */
  onStoryboard: () => void;
}

export function ShotTableRow({
  shot,
  selected,
  characters,
  busyVideo,
  busyContinue,
  busyLipsync,
  onSelect,
  onOpenProduce,
  onSave,
  onRegenerate,
  onContinue,
  onLipsync,
  onStoryboard,
}: ShotTableRowProps) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(shot.prompt);
  const [mood, setMood] = useState(shot.mood ?? "");
  const [beat, setBeat] = useState(shot.beat ?? "");
  const [seam, setSeam] = useState(shot.seam_to_next ?? "");
  const [seamAnchor, setSeamAnchor] = useState(shot.seam_anchor ?? "");
  // 行内编辑 prompt 自动增高(编辑区展开时重算,长 prompt 不再 rows=3 截断)
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(promptRef, prompt);

  // 外部数据刷新(轮询/宫格重建)且非编辑态时同步草稿
  useEffect(() => {
    if (!editing) {
      setPrompt(shot.prompt);
      setMood(shot.mood ?? "");
      setBeat(shot.beat ?? "");
      setSeam(shot.seam_to_next ?? "");
      setSeamAnchor(shot.seam_anchor ?? "");
    }
  }, [editing, shot.prompt, shot.mood, shot.beat, shot.seam_to_next, shot.seam_anchor]);

  const videoTone = shotTone(shot.video_status);
  const videoDone = videoTone === "done";
  const voiceDone = shotTone(shot.voice_status) === "done";

  const assetChars = (shot.characters ?? [])
    .map((name) => characters.find((c) => c.name === name))
    .filter((c): c is DramaCharacterItem => !!c);

  const enterEdit = () => {
    setPrompt(shot.prompt);
    setMood(shot.mood ?? "");
    setBeat(shot.beat ?? "");
    setSeam(shot.seam_to_next ?? "");
    setSeamAnchor(shot.seam_anchor ?? "");
    setEditing(true);
  };
  const handleSave = () => {
    onSave({
      prompt: prompt.trim(),
      mood: mood.trim(),
      beat: beat.trim(),
      seam_to_next: seam,
      // 锚点仅 matchcut/overlap 有意义,其余策略清空(与后端口径一致)
      seam_anchor: seamNeedsAnchor(seam) ? seamAnchor.trim() : "",
    });
    setEditing(false);
  };

  return (
    <>
      <tr
        id={`wb-shot-${shot.id}`}
        className={`wb-shot-row${selected ? " is-selected" : ""}`}
        onClick={onSelect}
      >
        {/* 镜号(点击进短片页) */}
        <td className="wb-col-idx">
          <button
            type="button"
            className="wb-shot-idx"
            title="在短片页打开"
            onClick={(e) => {
              e.stopPropagation();
              onOpenProduce(shot.id);
            }}
          >
            #{shot.idx}
          </button>
          {shot.scene && <span className="wb-shot-scene">{shot.scene}</span>}
        </td>
        {/* 资产:角色缩略圆片(hover 放大) */}
        <td className="wb-col-assets">
          {assetChars.length === 0 && <span className="wb-dim">—</span>}
          <span className="wb-avatars">
            {assetChars.slice(0, 4).map((c) =>
              c.reference_front ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={c.id}
                  className="wb-avatar"
                  src={imageUrl(c.reference_front)}
                  alt={c.name}
                  title={c.name}
                  width={28}
                  height={28}
                />
              ) : (
                <span key={c.id} className="wb-avatar wb-avatar-ph" title={c.name}>
                  {c.name.slice(0, 1)}
                </span>
              ),
            )}
            {assetChars.length > 4 && (
              <span className="wb-avatar wb-avatar-ph">+{assetChars.length - 4}</span>
            )}
          </span>
        </td>
        {/* 画面描述:截断两行 + mood/beat 旁注,点击展开编辑 */}
        <td className="wb-col-prompt">
          <div
            className="wb-prompt"
            title="点击展开编辑"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              enterEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                enterEdit();
              }
            }}
          >
            {shot.prompt || <span className="wb-dim">(无描述)</span>}
          </div>
          {(shot.mood || shot.beat || shot.seam_to_next) && (
            <div className="wb-shot-tags">
              {!!shot.seam_to_next && !!SEAM_KIND_LABEL[shot.seam_to_next] && (
                <span
                  className="wb-chip"
                  title={
                    shot.seam_anchor
                      ? `接缝:${SEAM_KIND_LABEL[shot.seam_to_next]}(锚点:${shot.seam_anchor})`
                      : `接缝:${SEAM_KIND_LABEL[shot.seam_to_next]}`
                  }
                >
                  接缝·{SEAM_KIND_LABEL[shot.seam_to_next]}
                </span>
              )}
              {shot.mood && (
                <span className="wb-chip" title="情绪标签">
                  {shot.mood}
                </span>
              )}
              {shot.beat && (
                <span className="wb-chip" title="节拍注记">
                  {shot.beat}
                </span>
              )}
            </div>
          )}
        </td>
        {/* 故事板 */}
        <td className="wb-col-board">
          {shot.keyframe_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="wb-board-thumb"
              src={imageUrl(shot.keyframe_url)}
              alt={`镜头 ${shot.idx} 故事板`}
              width={56}
              height={32}
            />
          ) : (
            <button
              type="button"
              className="wb-icon-text-btn"
              title="经宫格分镜统一生成故事板图(会重建全部分镜)"
              onClick={(e) => {
                e.stopPropagation();
                onStoryboard();
              }}
            >
              <Icon name="image" size={12} />
              生成故事板
            </button>
          )}
        </td>
        {/* 状态(诚实降级徽章) */}
        <td className="wb-col-status">
          <ShotStatusBadge status={shot.video_status} error={shot.error} />
        </td>
        {/* 时长 */}
        <td className="wb-col-dur">{(shot.duration_sec || 0).toFixed(1)}s</td>
        {/* 操作 */}
        <td className="wb-col-ops" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="wb-icon-btn"
            title={busyVideo ? "生成中…" : "重生成(换 seed)"}
            disabled={busyVideo}
            onClick={onRegenerate}
          >
            <Icon name={busyVideo ? "loading" : "refresh"} size={13} />
          </button>
          <button
            type="button"
            className={`wb-icon-btn${editing ? " is-active" : ""}`}
            title="编辑描述/情绪/节拍"
            aria-expanded={editing}
            onClick={() => (editing ? setEditing(false) : enterEdit())}
          >
            <Icon name="pencil" size={13} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title={
              videoDone
                ? busyContinue
                  ? "续写中…"
                  : "末帧续写 1 段并自动拼接"
                : "需先生成视频"
            }
            disabled={!videoDone || busyContinue}
            onClick={onContinue}
          >
            <Icon name={busyContinue ? "loading" : "replay"} size={13} />
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            title={
              !videoDone
                ? "需先生成视频"
                : !voiceDone
                  ? "需先完成配音"
                  : busyLipsync
                    ? "对口型中…"
                    : "对口型(源视频 + 配音)"
            }
            disabled={!videoDone || !voiceDone || busyLipsync}
            onClick={onLipsync}
          >
            <Icon name={busyLipsync ? "loading" : "sparkles"} size={13} />
          </button>
        </td>
      </tr>
      {editing && (
        <tr className="wb-shot-edit">
          <td colSpan={7}>
            <div className="wb-edit-grid" onClick={(e) => e.stopPropagation()}>
              <label className="wb-edit-field">
                <span className="wb-edit-label">画面描述(prompt)</span>
                <textarea
                  ref={promptRef}
                  className="wb-textarea"
                  rows={3}
                  maxLength={2000}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>
              <div className="wb-edit-duo">
                <label className="wb-edit-field">
                  <span className="wb-edit-label">情绪标签(≤64 字)</span>
                  <input
                    className="wb-input"
                    maxLength={64}
                    value={mood}
                    placeholder="如:压抑 / 释然"
                    onChange={(e) => setMood(e.target.value)}
                  />
                </label>
                <label className="wb-edit-field">
                  <span className="wb-edit-label">节拍注记(≤200 字)</span>
                  <input
                    className="wb-input"
                    maxLength={200}
                    value={beat}
                    placeholder="如:0-3秒 中景推进,主角回头"
                    onChange={(e) => setBeat(e.target.value)}
                  />
                </label>
              </div>
              <div className="wb-edit-duo">
                <label className="wb-edit-field">
                  <span className="wb-edit-label">接缝策略(与下一镜)</span>
                  <select
                    className="wb-select"
                    aria-label="接缝策略"
                    value={seam}
                    onChange={(e) => setSeam(e.target.value)}
                  >
                    {SEAM_KIND_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                {seamNeedsAnchor(seam) && (
                  <label className="wb-edit-field">
                    <span className="wb-edit-label">衔接锚点(≤200 字)</span>
                    <input
                      className="wb-input"
                      maxLength={200}
                      value={seamAnchor}
                      placeholder="如:太刀刀刃 / 圆环 / 瞳孔 / 色块"
                      onChange={(e) => setSeamAnchor(e.target.value)}
                    />
                  </label>
                )}
              </div>
              <div className="wb-edit-ops">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleSave}
                >
                  <Icon name="check" size={13} />
                  保存
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setEditing(false)}
                >
                  取消
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
