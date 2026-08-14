"use client";

import { useEffect, useState } from "react";
import {
  imageUrl,
  type StudioCharacter,
  type StudioRenderMode,
  type StudioShot,
  type StudioShotInput,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Ripple } from "@/components/ui/Ripple";

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  queued: "排队中",
  rendering: "生成中",
  rendered: "已生成",
  voiced: "已配音",
  lipsynced: "已对口型",
  done: "完成",
  error: "失败",
};

/** 受控输入字段:外部值变化时同步(refresh 回写),本地编辑优先。 */
function useSynced(value: string): [string, (v: string) => void] {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return [v, setV];
}

export interface ShotCardProps {
  shot: StudioShot;
  characters: StudioCharacter[];
  busyRender: boolean;
  busyVoice: boolean;
  busyLipsync: boolean;
  onModeChange: (mode: StudioRenderMode) => void;
  onPatch: (fields: Partial<StudioShotInput>) => void;
  onRender: () => void;
  onVoice: () => void;
  onLipsync: () => void;
  onDelete: () => void;
}

/**
 * 分镜卡片:媒体预览 + 内联编辑 + 生成方式切换 + 单镜操作。
 * 编辑失焦即保存(onPatch);render_mode 切换会重置该镜媒体(后端语义)。
 */
export function ShotCard({
  shot,
  characters,
  busyRender,
  busyVoice,
  busyLipsync,
  onModeChange,
  onPatch,
  onRender,
  onVoice,
  onLipsync,
  onDelete,
}: ShotCardProps) {
  const [scene, setScene] = useSynced(shot.scene);
  const [dialogue, setDialogue] = useSynced(shot.dialogue);
  const [prompt, setPrompt] = useSynced(shot.prompt);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const busy = busyRender || busyVoice || busyLipsync;
  const mediaUrl = shot.final_clip_url || shot.video_url || shot.image_url;
  const isVideo = Boolean(shot.final_clip_url || shot.video_url);
  const rendering = shot.status === "rendering" || busyRender;

  return (
    <article className="studio-shot" data-status={shot.status}>
      {/* ── 媒体预览 ── */}
      <div className="studio-shot-media">
        {mediaUrl && isVideo ? (
          <video src={imageUrl(mediaUrl)} controls playsInline preload="metadata" />
        ) : mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl(mediaUrl)} alt={shot.scene || `分镜 ${shot.idx + 1}`} loading="lazy" />
        ) : (
          <div className={`studio-shot-empty${rendering ? " is-rendering" : ""}`}>
            <Icon name={rendering ? "loading" : "image"} size={22} />
            <span>{rendering ? "生成中…" : "未生成"}</span>
          </div>
        )}
        <span className={`studio-shot-badge is-${shot.status}`}>
          {STATUS_LABEL[shot.status] ?? shot.status}
        </span>
      </div>

      {/* ── 主体 ── */}
      <div className="studio-shot-body">
        <div className="studio-shot-head">
          <span className="studio-shot-idx">#{shot.idx + 1}</span>
          {/* 核心:分镜级生成方式切换 */}
          <div className="studio-shot-mode" role="group" aria-label="生成方式">
            <button
              type="button"
              className={shot.render_mode === "video" ? "is-active" : ""}
              disabled={busy}
              onClick={() => onModeChange("video")}
            >
              <Icon name="video" size={11} /> 视频
            </button>
            <button
              type="button"
              className={shot.render_mode === "image_motion" ? "is-active" : ""}
              disabled={busy}
              onClick={() => onModeChange("image_motion")}
            >
              <Icon name="image" size={11} /> 运镜
            </button>
          </div>
          <button
            type="button"
            className="studio-shot-del"
            title="删除该镜"
            disabled={busy}
            onClick={onDelete}
          >
            <Icon name="delete" size={13} />
          </button>
        </div>

        {/* 场景描述(内联编辑) */}
        <input
          className="input studio-shot-scene-input"
          value={scene}
          placeholder="场景描述(中文)"
          onChange={(e) => setScene(e.target.value)}
          onBlur={() => scene !== shot.scene && onPatch({ scene })}
        />

        {/* 台词 + 说话人 */}
        <div className="studio-shot-line">
          <input
            className="input"
            value={dialogue}
            placeholder="台词(空 = 无配音)"
            onChange={(e) => setDialogue(e.target.value)}
            onBlur={() => dialogue !== shot.dialogue && onPatch({ dialogue })}
          />
          <select
            className="input studio-shot-speaker"
            value={shot.speaker}
            onChange={(e) => onPatch({ speaker: e.target.value })}
          >
            <option value="">旁白/无人</option>
            {characters.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* 高级:提示词/运镜/时长 */}
        <button
          type="button"
          className="studio-shot-adv-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <Icon name={showAdvanced ? "chevron-down" : "chevron-right"} size={12} />
          提示词与参数
        </button>
        {showAdvanced && (
          <div className="studio-shot-adv">
            <textarea
              className="input"
              rows={3}
              value={prompt}
              placeholder="英文生成提示词"
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => prompt !== shot.prompt && onPatch({ prompt })}
            />
            <div className="studio-shot-adv-row">
              <label>
                运镜
                <input
                  className="input"
                  defaultValue={shot.camera}
                  key={`cam-${shot.id}-${shot.camera}`}
                  placeholder="推/拉/摇/移"
                  onBlur={(e) =>
                    e.target.value !== shot.camera && onPatch({ camera: e.target.value })
                  }
                />
              </label>
              <label>
                时长(秒)
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={60}
                  defaultValue={shot.duration_sec}
                  key={`dur-${shot.id}-${shot.duration_sec}`}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (n >= 1 && n <= 60 && n !== shot.duration_sec)
                      onPatch({ duration_sec: n });
                  }}
                />
              </label>
            </div>
          </div>
        )}

        {shot.error && <p className="studio-shot-error">{shot.error}</p>}

        {/* ── 操作 ── */}
        <div className="studio-shot-actions">
          <Ripple>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onRender}>
              <Icon name={busyRender ? "loading" : "playing"} size={12} />
              {busyRender ? "生成中" : "生成"}
            </button>
          </Ripple>
          <Ripple>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy || !shot.dialogue}
              title={shot.dialogue ? "IndexTTS2 合成台词" : "无台词"}
              onClick={onVoice}
            >
              <Icon name={busyVoice ? "loading" : "mic"} size={12} />
              {busyVoice ? "配音中" : "配音"}
            </button>
          </Ripple>
          {shot.render_mode === "video" && (
            <Ripple>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy || !shot.video_url || !shot.voice_url}
                title={
                  shot.video_url && shot.voice_url ? "LatentSync 对口型" : "需先生成视频并配音"
                }
                onClick={onLipsync}
              >
                <Icon name={busyLipsync ? "loading" : "users"} size={12} />
                {busyLipsync ? "对口型中" : "对口型"}
              </button>
            </Ripple>
          )}
        </div>
      </div>
    </article>
  );
}
