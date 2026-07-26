"use client";

import { useEffect, useRef, useState } from "react";

import { imageUrl } from "@/lib/api";
import type {
  DramaCharacterItem,
  DramaSceneLayout,
  DramaSceneLayoutActor,
  DramaSceneLayoutProp,
  DramaShotItem,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { shotStatusMeta } from "@/components/drama-studio/ShotCard";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface ShotInspectorProps {
  project: UseDramaProjectReturn;
}

const FACINGS: { value: string; label: string }[] = [
  { value: "front", label: "前" },
  { value: "back", label: "后" },
  { value: "left", label: "左" },
  { value: "right", label: "右" },
];

// ── 导演台(紧凑版,适配 300px 检查器;交互逻辑对齐 ShotCard 内 DirectorPanel)──
interface DirectorBlockProps {
  shot: DramaShotItem;
  characters: DramaCharacterItem[];
  layout: DramaSceneLayout;
  onLayoutChange: (next: DramaSceneLayout) => void;
  busy: boolean;
  loading: boolean;
  onSave: (generateReference: boolean) => void;
}

function DirectorBlock({
  shot,
  characters,
  layout,
  onLayoutChange,
  busy,
  loading,
  onSave,
}: DirectorBlockProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<{ type: "actor" | "prop"; index: number } | null>(
    null,
  );
  const [propName, setPropName] = useState("");
  const [genRef, setGenRef] = useState(false);

  const addActor = (name: string) => {
    if (!name || layout.actors.some((a) => a.name === name)) return;
    onLayoutChange({
      ...layout,
      actors: [...layout.actors, { name, x: 50, y: 50, facing: "front", scale: 1 }],
    });
  };
  const addProp = () => {
    const name = propName.trim();
    if (!name || layout.props.some((p) => p.name === name)) return;
    onLayoutChange({
      ...layout,
      props: [...layout.props, { name, x: 50, y: 70, scale: 1 }],
    });
    setPropName("");
  };
  const removeActor = (i: number) =>
    onLayoutChange({ ...layout, actors: layout.actors.filter((_, x) => x !== i) });
  const updateActor = (i: number, patch: Partial<DramaSceneLayoutActor>) =>
    onLayoutChange({
      ...layout,
      actors: layout.actors.map((a, x) => (x === i ? { ...a, ...patch } : a)),
    });
  const removeProp = (i: number) =>
    onLayoutChange({ ...layout, props: layout.props.filter((_, x) => x !== i) });
  const updateProp = (i: number, patch: Partial<DramaSceneLayoutProp>) =>
    onLayoutChange({
      ...layout,
      props: layout.props.map((p, x) => (x === i ? { ...p, ...patch } : p)),
    });

  const startDrag =
    (type: "actor" | "prop", index: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = { type, index };
    };
  const onCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    const { type, index } = draggingRef.current;
    if (type === "actor") updateActor(index, { x, y });
    else updateProp(index, { x, y });
  };
  const onCanvasMouseUp = () => {
    draggingRef.current = null;
  };
  const updateCamera = (patch: Partial<DramaSceneLayout["camera"]>) =>
    onLayoutChange({ ...layout, camera: { ...layout.camera, ...patch } });

  return (
    <div className="fa-director">
      <div className="fa-director-head">
        <Icon name="canvas" size={12} />
        <span>导演台 · 分镜 #{shot.idx}</span>
      </div>
      <div className="fa-director-hint">拖拽标记调整位置 · 坐标 0-100%</div>

      {loading && (
        <div className="fa-director-loading">
          <Icon name="loading" size={13} className="fa-spin" />
          <span>加载场景布局…</span>
        </div>
      )}

      {/* 角色 chips */}
      <div className="fa-director-row">
        <span className="fa-director-label">角色</span>
        <div className="fa-director-chips">
          {characters.length === 0 && (
            <span className="fa-director-empty">无角色,先在角色库添加</span>
          )}
          {characters.map((c) => {
            const added = layout.actors.some((a) => a.name === c.name);
            return (
              <button
                key={c.id}
                type="button"
                className={`fa-director-chip ${added ? "fa-director-chip-added" : ""}`}
                onClick={() => addActor(c.name)}
                disabled={added || loading}
                title={added ? "已在画布上" : `添加 ${c.name} 到画布`}
              >
                <Icon name="user" size={10} />
                {c.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 道具 */}
      <div className="fa-director-row">
        <span className="fa-director-label">道具</span>
        <input
          className="fa-input fa-director-prop-input"
          value={propName}
          onChange={(e) => setPropName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addProp();
            }
          }}
          placeholder="道具名,回车添加"
          disabled={loading}
          maxLength={40}
        />
        <button
          type="button"
          className="fa-btn fa-btn-sm"
          onClick={addProp}
          disabled={loading || !propName.trim()}
        >
          <Icon name="create" size={11} />
        </button>
      </div>

      {/* 2D 画布(16:9) */}
      <div
        ref={canvasRef}
        className="fa-director-canvas"
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
      >
        {layout.actors.map((a, i) => (
          <div
            key={`a-${i}`}
            className="fa-director-actor"
            style={{
              left: `${a.x}%`,
              top: `${a.y}%`,
              transform: `translate(-50%, -50%) scale(${a.scale})`,
            }}
            onMouseDown={startDrag("actor", i)}
            title={`${a.name} · 拖拽移动`}
          >
            <Icon name="user" size={13} />
            <span className="fa-director-mark-name">{a.name}</span>
          </div>
        ))}
        {layout.props.map((p, i) => (
          <div
            key={`p-${i}`}
            className="fa-director-prop"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              transform: `translate(-50%, -50%) scale(${p.scale})`,
            }}
            onMouseDown={startDrag("prop", i)}
            title={`${p.name} · 拖拽移动`}
          >
            <Icon name="package" size={11} />
            <span className="fa-director-mark-name">{p.name}</span>
          </div>
        ))}
        {layout.actors.length === 0 && layout.props.length === 0 && !loading && (
          <div className="fa-director-canvas-empty">
            <Icon name="canvas" size={18} strokeWidth={1.4} />
            <span>点击上方角色/道具添加到画布</span>
          </div>
        )}
      </div>

      {/* 标记列表 */}
      {layout.actors.map((a, i) => (
        <div key={`al-${i}`} className="fa-director-item">
          <span className="fa-director-item-name">{a.name}</span>
          <select
            className="fa-input fa-director-facing"
            value={a.facing}
            onChange={(e) => updateActor(i, { facing: e.target.value })}
            disabled={busy}
          >
            {FACINGS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={a.scale}
            onChange={(e) => updateActor(i, { scale: Number(e.target.value) })}
            disabled={busy}
            className="fa-director-scale"
            title={`缩放 ${a.scale.toFixed(1)}`}
          />
          <button
            type="button"
            className="fa-director-del"
            onClick={() => removeActor(i)}
            disabled={busy}
            title="从画布移除"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
      {layout.props.map((p, i) => (
        <div key={`pl-${i}`} className="fa-director-item">
          <span className="fa-director-item-name">{p.name}</span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={p.scale}
            onChange={(e) => updateProp(i, { scale: Number(e.target.value) })}
            disabled={busy}
            className="fa-director-scale"
            title={`缩放 ${p.scale.toFixed(1)}`}
          />
          <button
            type="button"
            className="fa-director-del"
            onClick={() => removeProp(i)}
            disabled={busy}
            title="从画布移除"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}

      {/* 相机 */}
      <div className="fa-director-row">
        <span className="fa-director-label">相机</span>
        <label className="fa-director-slider">
          <span>角度</span>
          <input
            type="range"
            min={0}
            max={360}
            step={5}
            value={layout.camera.angle}
            onChange={(e) => updateCamera({ angle: Number(e.target.value) })}
            disabled={loading}
          />
          <em>{layout.camera.angle}°</em>
        </label>
      </div>
      <div className="fa-director-row">
        <span className="fa-director-label" />
        <label className="fa-director-slider">
          <span>距离</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={layout.camera.distance}
            onChange={(e) => updateCamera({ distance: Number(e.target.value) })}
            disabled={loading}
          />
          <em>{layout.camera.distance}</em>
        </label>
      </div>

      {/* 构图备注 */}
      <textarea
        className="fa-input fa-director-notes"
        value={layout.notes}
        onChange={(e) => onLayoutChange({ ...layout, notes: e.target.value })}
        rows={2}
        disabled={busy}
        placeholder="构图备注:俯视 / 角色居左三分之一…"
      />

      {/* 保存 */}
      <div className="fa-director-foot">
        <label className="fa-director-genref">
          <input
            type="checkbox"
            checked={genRef}
            onChange={(e) => setGenRef(e.target.checked)}
            disabled={busy}
          />
          <span>生成参考图</span>
        </label>
        <button
          type="button"
          className="fa-btn fa-btn-sm"
          onClick={() => onSave(false)}
          disabled={busy || loading}
          title="仅保存场景布局"
        >
          {busy ? (
            <Icon name="loading" size={12} className="fa-spin" />
          ) : (
            <Icon name="check" size={12} />
          )}
          保存布局
        </button>
        <button
          type="button"
          className="fa-btn fa-btn-amber fa-btn-sm"
          onClick={() => onSave(true)}
          disabled={busy || loading || !genRef}
          title={genRef ? "保存布局并生成构图参考图" : "先勾选「生成参考图」"}
        >
          <Icon name="sparkles" size={12} />
          生成
        </button>
      </div>
    </div>
  );
}

/**
 * Film Atelier · 镜头检查器(右侧导演台属性面板)。
 * 空态引导点击故事板;选中后可编辑场景/prompt/台词,
 * 单镜生成视频/配音,并可展开 2D 导演台精修构图。
 */
export function ShotInspector({ project }: ShotInspectorProps) {
  const {
    selectedShot,
    saveShot,
    generateVideo,
    generateVoice,
    busyShot,
    busyVoice,
    characters,
    directorOpen,
    directorLayout,
    directorBusy,
    directorLoading,
    toggleDirector,
    directorLayoutChange,
    saveDirector,
  } = project;

  const [prompt, setPrompt] = useState("");
  const [dialogue, setDialogue] = useState("");
  const [scene, setScene] = useState("");

  // 切换选中镜头时重置表单(轮询刷新不覆盖正在输入的内容)
  useEffect(() => {
    setPrompt(selectedShot?.prompt ?? "");
    setDialogue(selectedShot?.dialogue ?? "");
    setScene(selectedShot?.scene ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShot?.id]);

  return (
    <aside className="fa-panel">
      {!selectedShot ? (
        <div className="fa-panel-empty">
          <Icon name="film" size={26} strokeWidth={1.3} />
          <span>
            点击故事板中的镜头
            <br />
            在此精修构图与参数
          </span>
        </div>
      ) : (
        <>
          <h3 className="fa-panel-title">
            镜头 {String(selectedShot.idx).padStart(2, "0")}
          </h3>
          <div className="fa-panel-sub">
            {(selectedShot.scene || "分镜").toUpperCase()} ·{" "}
            {selectedShot.duration_sec > 0
              ? `${selectedShot.duration_sec}s`
              : "时长未定"}{" "}
            · SEED {selectedShot.seed ?? "—"}
          </div>

          {/* 状态徽章 */}
          <div className="fa-panel-badges">
            {(() => {
              const v = shotStatusMeta(selectedShot.video_status);
              const a = shotStatusMeta(selectedShot.voice_status);
              return (
                <>
                  <span className={`fa-pbadge fa-pbadge-${v.cls}`}>
                    <Icon
                      name={v.icon}
                      size={10}
                      className={
                        v.icon === "loading" || busyShot === selectedShot.id
                          ? "fa-spin"
                          : undefined
                      }
                    />
                    视频·{busyShot === selectedShot.id ? "生成中" : v.label}
                  </span>
                  <span className={`fa-pbadge fa-pbadge-${a.cls}`}>
                    <Icon
                      name={a.icon}
                      size={10}
                      className={
                        busyVoice === selectedShot.id ? "fa-spin" : undefined
                      }
                    />
                    配音·{busyVoice === selectedShot.id ? "合成中" : a.label}
                  </span>
                </>
              );
            })()}
          </div>

          {/* 编辑表单 */}
          <div className="fa-field">
            <label className="fa-field-label">场景</label>
            <input
              className="fa-input"
              value={scene}
              onChange={(e) => setScene(e.target.value)}
              maxLength={120}
            />
          </div>
          <div className="fa-field">
            <label className="fa-field-label">画面提示词</label>
            <textarea
              className="fa-input fa-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </div>
          <div className="fa-field">
            <label className="fa-field-label">台词(中文)</label>
            <textarea
              className="fa-input fa-textarea fa-textarea-sm"
              value={dialogue}
              onChange={(e) => setDialogue(e.target.value)}
              rows={2}
            />
          </div>

          {selectedShot.voice_url && (
            <audio
              controls
              src={imageUrl(selectedShot.voice_url)}
              className="fa-panel-audio"
            />
          )}

          {/* 操作 */}
          <div className="fa-panel-actions">
            <button
              type="button"
              className="fa-btn fa-btn-amber fa-btn-sm"
              onClick={() =>
                saveShot(selectedShot, { prompt, dialogue, scene })
              }
              disabled={
                prompt === selectedShot.prompt &&
                dialogue === selectedShot.dialogue &&
                scene === selectedShot.scene
              }
              title="保存场景/提示词/台词修改"
            >
              <Icon name="check" size={12} />
              保存修改
            </button>
            <button
              type="button"
              className="fa-btn fa-btn-sm"
              onClick={() => generateVideo(selectedShot)}
              disabled={busyShot === selectedShot.id}
              title="提交单镜视频生成(异步轮询)"
            >
              <Icon
                name={busyShot === selectedShot.id ? "loading" : "video"}
                size={12}
                className={busyShot === selectedShot.id ? "fa-spin" : undefined}
              />
              {busyShot === selectedShot.id ? "生成中" : "生成视频"}
            </button>
          </div>
          <div className="fa-panel-actions">
            <button
              type="button"
              className="fa-btn fa-btn-sm"
              onClick={() => generateVoice(selectedShot)}
              disabled={busyVoice === selectedShot.id || !selectedShot.dialogue}
              title="IndexTTS2 同步配音(需台词)"
            >
              <Icon
                name={busyVoice === selectedShot.id ? "loading" : "audio"}
                size={12}
                className={busyVoice === selectedShot.id ? "fa-spin" : undefined}
              />
              {busyVoice === selectedShot.id ? "配音中" : "配音"}
            </button>
            <button
              type="button"
              className="fa-btn fa-btn-sm"
              onClick={() => toggleDirector(selectedShot)}
              disabled={directorBusy}
              title={
                directorOpen === selectedShot.id
                  ? "收起导演台"
                  : "打开导演台(2D 场景布局)"
              }
              aria-expanded={directorOpen === selectedShot.id}
            >
              <Icon name="canvas" size={12} />
              {directorOpen === selectedShot.id ? "收起导演台" : "导演台"}
            </button>
          </div>

          {selectedShot.error && (
            <div className="fa-panel-error">{selectedShot.error}</div>
          )}

          {/* 导演台 2D 编辑器 */}
          {directorOpen === selectedShot.id && directorLayout && (
            <DirectorBlock
              shot={selectedShot}
              characters={characters}
              layout={directorLayout}
              onLayoutChange={directorLayoutChange}
              busy={directorBusy}
              loading={directorLoading}
              onSave={(g) => saveDirector(selectedShot, g)}
            />
          )}
        </>
      )}

      <style jsx>{`
        .fa-panel {
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line);
          border-radius: 10px;
          padding: 16px;
          overflow-y: auto;
          min-height: 0;
        }
        .fa-panel-empty {
          color: var(--fa-ink3);
          font-size: 12px;
          text-align: center;
          padding-top: 56px;
          line-height: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }
        .fa-panel-title {
          font-family: var(--fa-serif);
          font-size: 16px;
          font-weight: 600;
          color: var(--fa-ink);
          margin-bottom: 2px;
        }
        .fa-panel-sub {
          font-family: var(--fa-mono);
          font-size: 10px;
          letter-spacing: 0.1em;
          color: var(--fa-ink3);
          margin-bottom: 12px;
        }
        .fa-panel-badges {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-bottom: 14px;
        }
        .fa-pbadge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-family: var(--fa-mono);
          font-size: 9.5px;
          letter-spacing: 0.05em;
          padding: 2px 8px;
          border-radius: 3px;
          border: 1px solid var(--fa-line-hi);
          color: var(--fa-ink3);
        }
        .fa-pbadge-ds-st-done {
          color: var(--fa-green);
        }
        .fa-pbadge-ds-st-run {
          color: var(--fa-amber);
          border-color: var(--fa-amber-line);
          background: var(--fa-amber-soft);
        }
        .fa-pbadge-ds-st-err {
          color: var(--fa-red);
          border-color: var(--fa-red);
        }
        .fa-field {
          margin-bottom: 12px;
        }
        .fa-field-label {
          display: block;
          font-family: var(--fa-mono);
          font-size: 9.5px;
          letter-spacing: 0.16em;
          color: var(--fa-ink3);
          text-transform: uppercase;
          margin-bottom: 6px;
        }
        .fa-input {
          width: 100%;
          background: var(--fa-card);
          border: 1px solid var(--fa-line-hi);
          border-radius: 6px;
          color: var(--fa-ink);
          font-size: 12px;
          padding: 8px 11px;
          outline: none;
          transition: border-color 0.2s ease;
          font-family: inherit;
        }
        .fa-input:focus {
          border-color: var(--fa-amber-line);
        }
        .fa-textarea {
          min-height: 84px;
          resize: vertical;
          line-height: 1.6;
        }
        .fa-textarea-sm {
          min-height: 52px;
        }
        .fa-panel-audio {
          width: 100%;
          height: 30px;
          margin-bottom: 12px;
        }
        .fa-panel-actions {
          display: flex;
          gap: 8px;
          margin-bottom: 8px;
        }
        .fa-panel-actions .fa-btn {
          flex: 1;
          justify-content: center;
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
          padding: 6px 11px;
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
        .fa-btn-amber {
          background: var(--fa-amber);
          border-color: var(--fa-amber);
          color: var(--fa-bg);
          font-weight: 600;
        }
        .fa-btn-amber:hover:not(:disabled) {
          background: var(--fa-amber-hi);
          border-color: var(--fa-amber-hi);
          color: var(--fa-bg);
          box-shadow: 0 4px 16px var(--fa-amber-soft);
        }
        .fa-panel-error {
          margin-top: 4px;
          font-size: 11px;
          color: var(--fa-red);
          line-height: 1.5;
        }

        /* ── 导演台 ── */
        .fa-director {
          margin-top: 14px;
          border-top: 1px solid var(--fa-line);
          padding-top: 12px;
        }
        .fa-director-head {
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: var(--fa-serif);
          font-size: 13px;
          font-weight: 600;
          color: var(--fa-ink);
        }
        .fa-director-hint {
          font-family: var(--fa-mono);
          font-size: 9px;
          letter-spacing: 0.08em;
          color: var(--fa-ink3);
          margin: 4px 0 10px;
        }
        .fa-director-loading {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--fa-amber);
          margin-bottom: 8px;
        }
        .fa-director-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .fa-director-label {
          font-family: var(--fa-mono);
          font-size: 9.5px;
          letter-spacing: 0.14em;
          color: var(--fa-ink3);
          width: 30px;
          flex-shrink: 0;
        }
        .fa-director-chips {
          display: flex;
          gap: 5px;
          flex-wrap: wrap;
        }
        .fa-director-empty {
          font-size: 10.5px;
          color: var(--fa-ink3);
        }
        .fa-director-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 10.5px;
          color: var(--fa-ink2);
          background: var(--fa-card);
          border: 1px solid var(--fa-line);
          border-radius: 20px;
          padding: 3px 9px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .fa-director-chip:hover:not(:disabled) {
          color: var(--fa-amber);
          border-color: var(--fa-amber-line);
        }
        .fa-director-chip-added {
          color: var(--fa-amber);
          border-color: var(--fa-amber-line);
          background: var(--fa-amber-soft);
        }
        .fa-director-chip:disabled {
          cursor: not-allowed;
        }
        .fa-director-prop-input {
          flex: 1;
          min-width: 0;
          padding: 6px 9px;
          font-size: 11px;
        }
        .fa-director-canvas {
          position: relative;
          aspect-ratio: 16 / 9;
          background: var(--fa-bg);
          border: 1px solid var(--fa-line);
          border-radius: 6px;
          overflow: hidden;
          margin-bottom: 8px;
        }
        .fa-director-actor,
        .fa-director-prop {
          position: absolute;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          cursor: grab;
          user-select: none;
          color: var(--fa-amber);
        }
        .fa-director-prop {
          color: var(--fa-ink2);
        }
        .fa-director-actor:active,
        .fa-director-prop:active {
          cursor: grabbing;
        }
        .fa-director-mark-name {
          font-size: 9px;
          font-family: var(--fa-mono);
          background: var(--fa-bg);
          opacity: 0.9;
          padding: 1px 5px;
          border-radius: 3px;
          max-width: 72px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fa-director-canvas-empty {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          color: var(--fa-ink3);
          font-size: 10.5px;
        }
        .fa-director-item {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 6px;
        }
        .fa-director-item-name {
          font-size: 11px;
          color: var(--fa-ink2);
          width: 56px;
          flex-shrink: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fa-director-facing {
          width: 52px;
          flex-shrink: 0;
          padding: 4px 6px;
          font-size: 11px;
        }
        .fa-director-scale {
          flex: 1;
          min-width: 0;
          accent-color: var(--fa-amber);
        }
        .fa-director-del {
          background: none;
          border: none;
          color: var(--fa-ink3);
          cursor: pointer;
          padding: 3px;
          display: flex;
          border-radius: 4px;
          transition: color 0.15s ease;
        }
        .fa-director-del:hover:not(:disabled) {
          color: var(--fa-red);
        }
        .fa-director-slider {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 10.5px;
          color: var(--fa-ink3);
        }
        .fa-director-slider input {
          flex: 1;
          accent-color: var(--fa-amber);
        }
        .fa-director-slider em {
          font-style: normal;
          font-family: var(--fa-mono);
          font-size: 10px;
          color: var(--fa-ink2);
          width: 34px;
          text-align: right;
        }
        .fa-director-notes {
          min-height: 44px;
          resize: vertical;
          font-size: 11px;
          margin-bottom: 10px;
        }
        .fa-director-foot {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .fa-director-genref {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 10.5px;
          color: var(--fa-ink2);
          cursor: pointer;
          margin-right: auto;
        }
        .fa-director-genref input {
          accent-color: var(--fa-amber);
        }
        .fa-spin {
          animation: fa-spin 1s linear infinite;
        }
        @keyframes fa-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fa-spin {
            animation: none;
          }
          .fa-btn,
          .fa-input,
          .fa-director-chip,
          .fa-director-del {
            transition: none;
          }
          .fa-btn:hover:not(:disabled) {
            transform: none;
          }
        }
      `}</style>
    </aside>
  );
}
