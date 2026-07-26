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
import { Icon, type IconName } from "@/components/ui/Icon";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

// ── 分镜视频/配音状态徽章 ──
export function shotStatusMeta(status: string): {
  icon: IconName;
  label: string;
  cls: string;
} {
  const s = (status || "").toLowerCase();
  if (s === "done" || s === "ready" || s === "completed")
    return { icon: "success", label: "完成", cls: "ds-st-done" };
  if (s === "generating" || s === "running" || s === "processing")
    return { icon: "loading", label: "生成中", cls: "ds-st-run" };
  if (s === "error" || s === "failed")
    return { icon: "error", label: "失败", cls: "ds-st-err" };
  return { icon: "queued", label: "待处理", cls: "ds-st-draft" };
}

// ── M3:导演台 2D 编辑器子组件 ──
interface DirectorPanelProps {
  shot: DramaShotItem;
  characters: DramaCharacterItem[];
  layout: DramaSceneLayout;
  onLayoutChange: (next: DramaSceneLayout) => void;
  busy: boolean;
  loading: boolean;
  onSave: (generateReference: boolean) => void;
}

const FACINGS: { value: string; label: string }[] = [
  { value: "front", label: "前" },
  { value: "back", label: "后" },
  { value: "left", label: "左" },
  { value: "right", label: "右" },
];

// M2.3:DirectorPanel 提升为 export,供 DramaStudioView 顶层 overlay 渲染
export function DirectorPanel({
  shot,
  characters,
  layout,
  onLayoutChange,
  busy,
  loading,
  onSave,
}: DirectorPanelProps) {
  // 拖拽状态(用 ref 防止 mousemove 抖动触发重渲染)
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<
    | { type: "actor" | "prop"; index: number }
    | null
  >(null);
  const [propName, setPropName] = useState("");
  const [genRef, setGenRef] = useState(false);

  // 添加角色到画布(去重)
  const addActor = (name: string) => {
    if (!name) return;
    if (layout.actors.some((a) => a.name === name)) return;
    onLayoutChange({
      ...layout,
      actors: [
        ...layout.actors,
        { name, x: 50, y: 50, facing: "front", scale: 1 },
      ],
    });
  };

  // 添加道具
  const addProp = () => {
    const name = propName.trim();
    if (!name) return;
    if (layout.props.some((p) => p.name === name)) return;
    onLayoutChange({
      ...layout,
      props: [...layout.props, { name, x: 50, y: 70, scale: 1 }],
    });
    setPropName("");
  };

  // 删除/更新角色
  const removeActor = (i: number) => {
    onLayoutChange({
      ...layout,
      actors: layout.actors.filter((_, idx) => idx !== i),
    });
  };
  const updateActor = (i: number, patch: Partial<DramaSceneLayoutActor>) => {
    onLayoutChange({
      ...layout,
      actors: layout.actors.map((a, idx) =>
        idx === i ? { ...a, ...patch } : a,
      ),
    });
  };

  // 删除/更新道具
  const removeProp = (i: number) => {
    onLayoutChange({
      ...layout,
      props: layout.props.filter((_, idx) => idx !== i),
    });
  };
  const updateProp = (i: number, patch: Partial<DramaSceneLayoutProp>) => {
    onLayoutChange({
      ...layout,
      props: layout.props.map((p, idx) =>
        idx === i ? { ...p, ...patch } : p,
      ),
    });
  };

  // 拖拽:鼠标按下标记 → 记录 type/index;移动 → 实时更新坐标;抬起 → 清状态
  const startDrag =
    (type: "actor" | "prop", index: number) =>
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = { type, index };
    };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(100, ((e.clientX - rect.left) / rect.width) * 100),
    );
    const y = Math.max(
      0,
      Math.min(100, ((e.clientY - rect.top) / rect.height) * 100),
    );
    const { type, index } = draggingRef.current;
    if (type === "actor") updateActor(index, { x, y });
    else updateProp(index, { x, y });
  };

  const onCanvasMouseUp = () => {
    draggingRef.current = null;
  };

  // 相机参数更新
  const updateCamera = (patch: Partial<DramaSceneLayout["camera"]>) => {
    onLayoutChange({ ...layout, camera: { ...layout.camera, ...patch } });
  };

  return (
    <div className="ds-director-panel">
      <div className="ds-director-head">
        <Icon name="canvas" size={13} />
        <span>导演台 · 分镜 #{shot.idx}</span>
        <span className="ds-director-hint">
          拖拽角色/道具标记调整位置 · 坐标 0-100%
        </span>
      </div>

      {loading && (
        <div className="ds-director-loading">
          <Icon name="loading" size={14} className="ds-spin" />
          <span>加载场景布局…</span>
        </div>
      )}

      {/* 顶部工具栏 */}
      <div className="ds-director-toolbar">
        <div className="ds-director-toolbar-row">
          <span className="ds-director-toolbar-label">角色</span>
          <div className="ds-director-actor-chips">
            {characters.length === 0 && (
              <span className="ds-director-empty-hint">无角色,先在角色库添加</span>
            )}
            {characters.map((c) => {
              const added = layout.actors.some((a) => a.name === c.name);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`ds-director-actor-chip ${added ? "ds-director-actor-chip-added" : ""}`}
                  onClick={() => addActor(c.name)}
                  disabled={added || loading}
                  title={added ? "已在画布上" : `添加 ${c.name} 到画布`}
                >
                  <Icon name="user" size={10} />
                  {c.name}
                  {added ? " ✓" : " +"}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ds-director-toolbar-row">
          <span className="ds-director-toolbar-label">道具</span>
          <input
            className="ds-input ds-director-prop-input"
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
            className="btn btn-sm"
            onClick={addProp}
            disabled={loading || !propName.trim()}
          >
            <Icon name="create" size={11} />
            添加
          </button>
        </div>
        <div className="ds-director-toolbar-row">
          <span className="ds-director-toolbar-label">相机</span>
          <label className="ds-director-slider">
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
          <label className="ds-director-slider">
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
      </div>

      {/* 2D 画布(16:9,固定 480x270) */}
      <div
        ref={canvasRef}
        className="ds-director-canvas"
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
      >
        {/* 角色:圆形标记 */}
        {layout.actors.map((a, i) => (
          <div
            key={`a-${i}`}
            className="ds-director-actor"
            style={{
              left: `${a.x}%`,
              top: `${a.y}%`,
              transform: `translate(-50%, -50%) scale(${a.scale})`,
            }}
            onMouseDown={startDrag("actor", i)}
            title={`${a.name} · 拖拽移动`}
          >
            <Icon name="user" size={14} />
            <span className="ds-director-mark-name">{a.name}</span>
          </div>
        ))}
        {/* 道具:方形标记 */}
        {layout.props.map((p, i) => (
          <div
            key={`p-${i}`}
            className="ds-director-prop"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              transform: `translate(-50%, -50%) scale(${p.scale})`,
            }}
            onMouseDown={startDrag("prop", i)}
            title={`${p.name} · 拖拽移动`}
          >
            <Icon name="package" size={12} />
            <span className="ds-director-mark-name">{p.name}</span>
          </div>
        ))}
        {/* 空画布提示 */}
        {layout.actors.length === 0 && layout.props.length === 0 && !loading && (
          <div className="ds-director-canvas-empty">
            <Icon name="canvas" size={20} strokeWidth={1.4} />
            <span>点击上方角色/道具添加到画布</span>
          </div>
        )}
      </div>

      {/* 标记详细控件列表 */}
      <div className="ds-director-list">
        {layout.actors.length > 0 && (
          <div className="ds-director-list-group">
            <span className="ds-director-list-title">角色</span>
            {layout.actors.map((a, i) => (
              <div key={`al-${i}`} className="ds-director-list-row">
                <span className="ds-director-list-name">{a.name}</span>
                <label className="ds-director-list-field">
                  <span>朝向</span>
                  <select
                    className="ds-input"
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
                </label>
                <label className="ds-director-list-field ds-director-list-field-scale">
                  <span>缩放</span>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={a.scale}
                    onChange={(e) =>
                      updateActor(i, { scale: Number(e.target.value) })
                    }
                    disabled={busy}
                  />
                  <em>{a.scale.toFixed(1)}</em>
                </label>
                <button
                  type="button"
                  className="ds-mini-btn ds-mini-btn-danger"
                  onClick={() => removeActor(i)}
                  disabled={busy}
                  title="从画布移除"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {layout.props.length > 0 && (
          <div className="ds-director-list-group">
            <span className="ds-director-list-title">道具</span>
            {layout.props.map((p, i) => (
              <div key={`pl-${i}`} className="ds-director-list-row">
                <span className="ds-director-list-name">{p.name}</span>
                <label className="ds-director-list-field ds-director-list-field-scale">
                  <span>缩放</span>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={p.scale}
                    onChange={(e) =>
                      updateProp(i, { scale: Number(e.target.value) })
                    }
                    disabled={busy}
                  />
                  <em>{p.scale.toFixed(1)}</em>
                </label>
                <button
                  type="button"
                  className="ds-mini-btn ds-mini-btn-danger"
                  onClick={() => removeProp(i)}
                  disabled={busy}
                  title="从画布移除"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <label className="ds-field ds-director-notes">
          <span className="ds-field-label">构图备注</span>
          <textarea
            className="ds-textarea"
            value={layout.notes}
            onChange={(e) => onLayoutChange({ ...layout, notes: e.target.value })}
            rows={2}
            disabled={busy}
            placeholder="如:俯视构图 / 角色位于左侧三分之一处..."
          />
        </label>
      </div>

      {/* 底部:保存 + 生成参考图 */}
      <div className="ds-director-foot">
        <label className="ds-director-genref">
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
          className="btn btn-sm"
          onClick={() => onSave(false)}
          disabled={busy || loading}
          title="仅保存场景布局"
        >
          {busy ? (
            <>
              <Icon name="loading" size={12} className="ds-spin" />
              保存中…
            </>
          ) : (
            <>
              <Icon name="check" size={12} />
              保存布局
            </>
          )}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onSave(true)}
          disabled={busy || loading || !genRef}
          title={genRef ? "保存布局并生成构图参考图" : "先勾选「生成参考图」"}
        >
          {busy ? (
            <>
              <Icon name="loading" size={12} className="ds-spin" />
              生成中…
            </>
          ) : (
            <>
              <Icon name="sparkles" size={12} />
              生成
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ── ShotCard 子组件 ──
interface ShotCardProps {
  shot: DramaShotItem;
  project: UseDramaProjectReturn;
}

export function ShotCard({ shot, project }: ShotCardProps) {
  const {
    busyShot,
    editingShot,
    setEditingShot,
    saveShot,
    // M3:导演台(M2.3:overlay 化,ShotCard 仅保留触发入口 + busy 状态)
    directorBusy,
    openDirectorOverlay,
    // M6:模型聚合
    videoModel,
    videoGenerators,
    videoModelLoading,
    setVideoModel,
  } = project;

  const [editPrompt, setEditPrompt] = useState(shot.prompt ?? "");
  const [editDialogue, setEditDialogue] = useState(shot.dialogue ?? "");
  const [editScene, setEditScene] = useState(shot.scene ?? "");

  // 仅在进入编辑态(或切换到本镜编辑)时初始化表单,避免轮询刷新覆盖用户输入
  useEffect(() => {
    if (editingShot === shot.id) {
      setEditPrompt(shot.prompt ?? "");
      setEditDialogue(shot.dialogue ?? "");
      setEditScene(shot.scene ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingShot, shot.id]);

  const vMeta = shotStatusMeta(shot.video_status);
  const aMeta = shotStatusMeta(shot.voice_status);
  const isVideoBusy = busyShot === shot.id;
  const isEditing = editingShot === shot.id;
  // 后端返回的 generator 都是可用的;加载中/空列表时允许 ltx 默认
  const isModelAvailable =
    videoModel === "ltx" || videoGenerators.some((g) => g.name === videoModel);

  return (
    <article className="ds-shot-card">
      <div className="ds-shot-head">
        <span className="ds-shot-idx">#{shot.idx}</span>
        <span className={`ds-badge-status ${vMeta.cls}`}>
          <Icon
            name={vMeta.icon}
            size={11}
            strokeWidth={1.9}
            className={vMeta.icon === "loading" ? "ds-spin" : undefined}
          />
          视频·{vMeta.label}
        </span>
      </div>

      <div className="ds-shot-media">
        {shot.video_url ? (
          <video
            src={imageUrl(shot.video_url)}
            controls
            playsInline
            preload="metadata"
            className="ds-shot-video"
          />
        ) : (
          <div className="ds-shot-placeholder">
            <Icon name="video" size={26} strokeWidth={1.3} />
            <span>{isVideoBusy ? "生成中…" : "未出片"}</span>
          </div>
        )}
      </div>

      <div className="ds-shot-body">
        {isEditing ? (
          <div className="ds-shot-edit">
            <label className="ds-field">
              <span className="ds-field-label">场景</span>
              <input
                className="ds-input"
                value={editScene}
                onChange={(e) => setEditScene(e.target.value)}
                maxLength={120}
              />
            </label>
            <label className="ds-field">
              <span className="ds-field-label">视频提示词(prompt)</span>
              <textarea
                className="ds-textarea"
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                rows={3}
              />
            </label>
            <label className="ds-field">
              <span className="ds-field-label">台词(中文)</span>
              <textarea
                className="ds-textarea"
                value={editDialogue}
                onChange={(e) => setEditDialogue(e.target.value)}
                rows={2}
              />
            </label>
            <div className="ds-shot-edit-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setEditingShot(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() =>
                  saveShot(shot, {
                    prompt: editPrompt,
                    dialogue: editDialogue,
                    scene: editScene,
                  })
                }
              >
                <Icon name="check" size={12} /> 保存
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="ds-shot-scene" title={shot.scene}>
              {shot.scene || `分镜 ${shot.idx}`}
            </div>
            {shot.prompt && <p className="ds-shot-prompt">{shot.prompt}</p>}
            {shot.dialogue && (
              <p className="ds-shot-dialogue">&ldquo;{shot.dialogue}&rdquo;</p>
            )}
            <div className="ds-shot-tags">
              {shot.speaker && (
                <span className="ds-shot-tag ds-shot-tag-speaker">
                  <Icon name="mic" size={10} />
                  {shot.speaker}
                </span>
              )}
              {shot.characters?.map((c) => (
                <span key={c} className="ds-shot-tag">
                  {c}
                </span>
              ))}
              {shot.duration_sec > 0 && (
                <span className="ds-shot-tag">{shot.duration_sec}s</span>
              )}
            </div>

            {/* 配音状态 + 播放器 */}
            <div className="ds-shot-voice">
              <span className={`ds-badge-status ${aMeta.cls}`}>
                <Icon
                  name={aMeta.icon}
                  size={10}
                  strokeWidth={1.9}
                  className={aMeta.icon === "loading" ? "ds-spin" : undefined}
                />
                配音·{aMeta.label}
              </span>
              {shot.voice_url && (
                <audio
                  controls
                  src={imageUrl(shot.voice_url)}
                  className="ds-shot-audio"
                />
              )}
            </div>

            {/* M6:模型聚合选择器(单镜视频生成模型) */}
            <div className="ds-model-row">
              <label className="ds-model-label">
                <Icon name="cpu" size={11} />
                <span>模型</span>
              </label>
              <select
                className="ds-input ds-model-select"
                value={videoModel}
                onChange={(e) => setVideoModel(e.target.value)}
                disabled={videoModelLoading || isVideoBusy}
                title="选择视频生成模型"
              >
                {videoModelLoading && videoGenerators.length === 0 && (
                  <option value="ltx">ltx(默认)</option>
                )}
                {videoGenerators.length === 0 && !videoModelLoading && (
                  <option value="ltx">ltx(默认)</option>
                )}
                {videoGenerators.filter((g) => g.available).map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.display_name || g.name}
                  </option>
                ))}
              </select>
              {!isModelAvailable && (
                <span className="ds-model-warn" title="该模型尚未接入">
                  <Icon name="warning" size={11} />
                  未接入
                </span>
              )}
            </div>

            {/* 单镜操作(M2.1:生成视频/配音已移至 ShotTab 顶部批量工具栏) */}
            <div className="ds-shot-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => openDirectorOverlay(shot)}
                disabled={directorBusy}
                title="打开导演台(2D 场景布局,全屏编辑)"
              >
                <Icon name="canvas" size={12} />
                导演台
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setEditingShot(shot.id)}
                disabled={isVideoBusy}
                title="编辑分镜"
              >
                <Icon name="create" size={12} /> 编辑
              </button>
            </div>
          </>
        )}
      </div>
    </article>
  );
}
