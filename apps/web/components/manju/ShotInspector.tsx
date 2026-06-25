"use client";

import { OptimizeButton } from "@/components/ui/OptimizeButton";

import type { ShotCard } from "./types";

interface ShotInspectorProps {
  shot: ShotCard | null;
  index: number;
  busy: boolean;
  onChange: (id: string, patch: Partial<ShotCard>) => void;
  onImage: (id: string) => void;
  onVideo: (id: string) => void;
}

/** 右侧选中镜头属性面板:可编辑出图提示词 / 台词,AI 润色,并触发出图 / 转视频。 */
export function ShotInspector({
  shot,
  index,
  busy,
  onChange,
  onImage,
  onVideo,
}: ShotInspectorProps) {
  if (!shot) {
    return (
      <aside className="manju-inspector is-empty" aria-label="镜头属性">
        <span className="manju-inspector-empty-mark" aria-hidden="true">
          ◍
        </span>
        <p className="manju-inspector-hint">在分镜板中选择一个镜头,查看与编辑属性</p>
      </aside>
    );
  }

  return (
    <aside className="manju-inspector" aria-label={`镜 ${index + 1} 属性`}>
      <header className="manju-inspector-head">
        <h3>镜 {index + 1}</h3>
        <span className="manju-inspector-dur">{shot.duration_sec}s</span>
      </header>

      {shot.imageUrl && (
        <div className="manju-inspector-preview">
          {shot.videoUrl ? (
            <video src={shot.videoUrl} controls playsInline preload="metadata" poster={shot.imageUrl} />
          ) : (
            <img src={shot.imageUrl} alt={`镜 ${index + 1} 产物`} />
          )}
        </div>
      )}

      <div className="field">
        <label>场景</label>
        <p className="manju-inspector-scene">{shot.scene || "—"}</p>
      </div>

      <div className="field">
        <label htmlFor="manju-desc">
          <span>出图提示词(英文)</span>
          <OptimizeButton
            value={shot.description}
            kind="image"
            disabled={busy}
            onResult={(v) => onChange(shot.id, { description: v })}
            onNegative={(n) => onChange(shot.id, { negative: n })}
          />
        </label>
        <textarea
          id="manju-desc"
          rows={4}
          value={shot.description}
          onChange={(e) => onChange(shot.id, { description: e.target.value })}
        />
      </div>

      {shot.negative !== undefined && (
        <div className="field">
          <label htmlFor="manju-neg">反向提示词(AI 润色生成 · 可改)</label>
          <textarea
            id="manju-neg"
            rows={2}
            value={shot.negative}
            onChange={(e) => onChange(shot.id, { negative: e.target.value })}
            placeholder="排除的瑕疵 / 不想要的元素"
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="manju-line">台词 / 旁白</label>
        <textarea
          id="manju-line"
          rows={2}
          value={shot.dialogue}
          onChange={(e) => onChange(shot.id, { dialogue: e.target.value })}
        />
      </div>

      <div className="field">
        <label>运镜</label>
        <p className="manju-inspector-cam">{shot.camera || "—"}</p>
      </div>

      {shot.characters.length > 0 && (
        <div className="field">
          <label>出场角色</label>
          <div className="manju-shot-chars">
            {shot.characters.map((c) => (
              <span className="manju-char-tag" key={c}>
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="manju-inspector-actions">
        <button
          type="button"
          className="generate-btn"
          disabled={busy || shot.status === "imaging" || !shot.description.trim()}
          onClick={() => onImage(shot.id)}
        >
          {shot.status === "imaging" ? "出图中…" : shot.imageUrl ? "重新出图" : "出图"}
        </button>
        <button
          type="button"
          className="manju-secondary-btn"
          disabled={busy || !shot.imageUrl}
          onClick={() => onVideo(shot.id)}
        >
          转视频
        </button>
      </div>
    </aside>
  );
}
