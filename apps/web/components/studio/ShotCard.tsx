"use client";

import { useEffect, useRef, useState } from "react";
import {
  imageUrl,
  optimizeStudioShot,
  uploadImage,
  type StudioCharacter,
  type StudioRenderBody,
  type StudioRenderMode,
  type StudioShot,
  type StudioShotInput,
} from "@/lib/api";
import { collectAutoRefSlots, sceneImagesForShot, slotsToUrls } from "@/lib/studioVideoRefs";
import { Icon } from "@/components/ui/Icon";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Ripple } from "@/components/ui/Ripple";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { StudioSaveState } from "@/hooks/useStudioProject";
import { listAgents, type Agent } from "@/lib/agents";

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
  /** 项目 id(AI 扩写端点按项目注入角色表上下文) */
  projectId: string;
  characters: StudioCharacter[];
  busyRender: boolean;
  busyVoice: boolean;
  busyLipsync: boolean;
  /** 失焦自动保存状态(项目级,所有卡片共享) */
  saveState: StudioSaveState;
  savedAt: Date | null;
  /** Batch2:视频步焦点时展示引擎/多候选/多参考 */
  videoFocus?: boolean;
  /** 项目级默认引擎(视频步工具栏) */
  defaultVideoModel?: "h3" | "ltx";
  /** 项目级默认候选数 */
  defaultNumCandidates?: number;
  /** Batch3:项目绑定场景图(视频多参考自动带入) */
  projectSceneImages?: string[];
  onModeChange: (mode: StudioRenderMode) => void;
  onPatch: (fields: Partial<StudioShotInput>) => void;
  onRender: (body?: StudioRenderBody) => void;
  onCancelRender?: () => void;
  onPickCandidate?: (cid: string) => void;
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
  projectId,
  characters,
  busyRender,
  busyVoice,
  busyLipsync,
  saveState,
  savedAt,
  videoFocus = false,
  defaultVideoModel = "h3",
  defaultNumCandidates = 2,
  projectSceneImages = [],
  onModeChange,
  onPatch,
  onRender,
  onCancelRender,
  onPickCandidate,
  onVoice,
  onLipsync,
  onDelete,
}: ShotCardProps) {
  const [scene, setScene] = useSynced(shot.scene);
  const [dialogue, setDialogue] = useSynced(shot.dialogue);
  const [prompt, setPrompt] = useSynced(shot.prompt);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 分镜提示词自动增高(高级区展开,长 prompt 不再 rows=3 截断)
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(promptRef, prompt);

  // ── AI 扩写(2026-08-18):一句简短描述 → 结构化分镜回填;可选 Skill 风格人格叠加 ──
  const [brief, setBrief] = useState("");
  const [styleHint, setStyleHint] = useState("");
  const [skillId, setSkillId] = useState("");
  const [skills, setSkills] = useState<Agent[]>([]);
  const [optimizing, setOptimizing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // Batch2 视频步:引擎默认 H3;候选数默认 2;场景参考可追加
  const [videoModel, setVideoModel] = useState<"h3" | "ltx">(
    (shot.video_model === "ltx" ? "ltx" : defaultVideoModel) as "h3" | "ltx",
  );
  const [numCandidates, setNumCandidates] = useState(
    Math.min(4, Math.max(1, defaultNumCandidates || 2)),
  );
  /** 空=自动推断；双桶并存时选风格才能吃到过审分桶 refs */
  const [refStyle, setRefStyle] = useState<"" | "anime" | "ancient_realistic">("");
  const [sceneRefs, setSceneRefs] = useState<string[]>(() => {
    const bound = new Set((projectSceneImages || []).filter(Boolean));
    const autoChar = new Set(
      collectAutoRefSlots(characters, shot.characters).map((s) => s.url),
    );
    // 本镜追加 = shot.ref_images 去掉角色自动槽与项目绑定场景
    return (shot.ref_images || []).filter((u) => u && !autoChar.has(u) && !bound.has(u));
  });

  // 面板展开时拉可选技能(公共 + 本人导入,失败静默降级为无技能可选)
  useEffect(() => {
    if (!showAdvanced || skills.length > 0) return;
    let cancelled = false;
    listAgents("all")
      .then((list) => {
        if (!cancelled) setSkills(list.sort((a, b) => a.sort - b.sort));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showAdvanced, skills.length]);

  async function runOptimize() {
    if (!brief.trim() || optimizing) return;
    setOptimizing(true);
    setAiError(null);
    try {
      const r = await optimizeStudioShot(projectId, {
        brief: brief.trim(),
        shot_id: shot.id,
        ...(styleHint.trim() ? { style_hint: styleHint.trim() } : {}),
        ...(skillId ? { skill_id: skillId } : {}),
      });
      onPatch({
        scene: r.scene || scene,
        camera: r.camera || shot.camera,
        prompt: r.prompt || prompt,
        negative: r.negative || shot.negative,
        characters: r.characters,
      });
      // 本地受控态即时跟随(避免等全量保存回读才刷新)
      setScene(r.scene || scene);
      setPrompt(r.prompt || prompt);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "扩写失败,请稍后重试");
    } finally {
      setOptimizing(false);
    }
  }

  const busy = busyRender || busyVoice || busyLipsync;
  const mediaUrl = shot.final_clip_url || shot.video_url || shot.image_url;
  const isVideo = Boolean(shot.final_clip_url || shot.video_url);
  const rendering = shot.status === "rendering" || busyRender;

  const savedAtLabel = savedAt
    ? `${String(savedAt.getHours()).padStart(2, "0")}:${String(savedAt.getMinutes()).padStart(2, "0")}`
    : null;

  const showVideoOpts = videoFocus || shot.render_mode === "video";
  const mergedScenes = sceneImagesForShot(projectSceneImages, shot.idx, sceneRefs);
  const autoSlots = collectAutoRefSlots(characters, shot.characters, mergedScenes);
  const refUrls = slotsToUrls(autoSlots);
  const candidates = shot.candidates || [];

  const doRender = () => {
    if (!showVideoOpts) {
      onRender();
      return;
    }
    onRender({
      video_model: videoModel,
      pipeline: videoModel === "h3" ? "c" : undefined,
      num_candidates: numCandidates,
      ref_images: refUrls,
      ...(refStyle ? { ref_style: refStyle } : {}),
    });
  };

  return (
    <article className="studio-shot" data-status={shot.status}>
      {/* ── 媒体预览 ── */}
      <div className="studio-shot-media">
        {mediaUrl && isVideo ? (
          <video src={imageUrl(mediaUrl)} controls playsInline preload="metadata" />
        ) : mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl(mediaUrl)}
            alt={shot.scene || `分镜 ${shot.idx + 1}`}
            loading="lazy"
            decoding="async"
            /* CLS 防护:分镜预览统一 16:9;容器 .studio-shot-media 已定比,此处仅给浏览器
               纵横比提示,加载前后不跳动(对齐 LibraryView/ResultPanel 范式) */
            width={640}
            height={360}
          />
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
          {/* 失焦自动保存状态(轻量指示;失败另有顶部错误条) */}
          {saveState === "saving" && (
            <span className="shot-save-state" role="status">
              <Icon name="loading" size={11} /> 保存中…
            </span>
          )}
          {saveState === "saved" && savedAtLabel && (
            <span className="shot-save-state is-saved" role="status">
              <Icon name="check" size={11} /> 已保存 {savedAtLabel}
            </span>
          )}
          {saveState === "error" && (
            <span className="shot-save-state is-error" role="status">
              <Icon name="error" size={11} /> 保存失败
            </span>
          )}
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
        <Input
          className="studio-shot-scene-input"
          value={scene}
          placeholder="场景描述(中文)"
          onChange={(e) => setScene(e.target.value)}
          onBlur={() => scene !== shot.scene && onPatch({ scene })}
        />

        {/* 台词 + 说话人 */}
        <div className="studio-shot-line">
          <Input
            value={dialogue}
            placeholder="台词(空 = 无配音)"
            onChange={(e) => setDialogue(e.target.value)}
            onBlur={() => dialogue !== shot.dialogue && onPatch({ dialogue })}
          />
          <Select
            className="studio-shot-speaker"
            value={shot.speaker}
            onChange={(e) => onPatch({ speaker: e.target.value })}
          >
            <option value="">旁白/无人</option>
            {characters.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
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
            {/* AI 扩写:一句简短中文描述 → 场景/运镜/提示词/负向/角色全回填 */}
            <div className="studio-shot-ai">
              <Textarea
                rows={2}
                value={brief}
                placeholder="AI 扩写:一句话描述画面(如「阿豪在雨夜天台点烟」)"
                onChange={(e) => setBrief(e.target.value)}
                disabled={optimizing}
              />
              <div className="studio-shot-ai-row">
                <Select
                  className="studio-shot-skill"
                  value={skillId}
                  onChange={(e) => setSkillId(e.target.value)}
                  disabled={optimizing}
                  aria-label="风格技能(Skill 市场)"
                >
                  <option value="">风格:默认</option>
                  {skills.map((s) => (
                    <option key={s.id} value={s.id}>
                      风格:{s.name}
                      {s.is_mine ? "(我的)" : ""}
                    </option>
                  ))}
                </Select>
                <Input
                  value={styleHint}
                  placeholder="补充风格(可选,如「王家卫式霓虹」)"
                  onChange={(e) => setStyleHint(e.target.value)}
                  disabled={optimizing}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={!brief.trim() || optimizing}
                  onClick={() => void runOptimize()}
                >
                  <Icon name={optimizing ? "loading" : "sparkles"} size={12} />
                  {optimizing ? "扩写中…" : "AI 扩写"}
                </button>
              </div>
              {aiError && <p className="studio-shot-ai-error">{aiError}</p>}
            </div>
            <Textarea
              ref={promptRef}
              rows={3}
              value={prompt}
              placeholder="英文生成提示词"
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => prompt !== shot.prompt && onPatch({ prompt })}
            />
            <Textarea
              rows={2}
              defaultValue={shot.negative}
              key={`neg-${shot.id}-${shot.negative}`}
              placeholder="英文负向提示词(可选)"
              onBlur={(e) =>
                e.target.value !== shot.negative && onPatch({ negative: e.target.value })
              }
            />
            {characters.length > 0 && (
              <div className="studio-shot-chars" role="group" aria-label="出场角色">
                {characters.map((c) => {
                  const on = shot.characters.includes(c.name);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`studio-shot-char${on ? " is-on" : ""}`}
                      title={c.description}
                      onClick={() =>
                        onPatch({
                          characters: on
                            ? shot.characters.filter((n) => n !== c.name)
                            : [...shot.characters, c.name],
                        })
                      }
                    >
                      <Icon name={on ? "check" : "user"} size={11} />
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="studio-shot-adv-row">
              <label>
                运镜
                <Input
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
                <Input
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

        {/* Batch2 视频步:H3 默认 + 多参考 + 多候选 */}
        {showVideoOpts && (
          <div className="studio-video-opts" data-testid="studio-video-opts">
            <div className="studio-video-row">
              <label className="studio-video-engine">
                <Icon name="zap" size={12} />
                <select
                  value={videoModel}
                  disabled={busy}
                  aria-label="视频引擎"
                  onChange={(e) => setVideoModel(e.target.value === "ltx" ? "ltx" : "h3")}
                >
                  <option value="h3">H3</option>
                  <option value="ltx">LTX</option>
                </select>
              </label>
              <label className="studio-video-cands">
                候选
                <select
                  value={numCandidates}
                  disabled={busy}
                  aria-label="候选数"
                  onChange={(e) => setNumCandidates(Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-video-refstyle" data-testid="studio-video-refstyle">
                设定卡
                <select
                  value={refStyle}
                  disabled={busy}
                  aria-label="参考风格"
                  onChange={(e) => {
                    const v = e.target.value;
                    setRefStyle(
                      v === "anime" || v === "ancient_realistic" ? v : "",
                    );
                  }}
                >
                  <option value="">自动</option>
                  <option value="anime">二次元</option>
                  <option value="ancient_realistic">古风</option>
                </select>
              </label>
            </div>
            <div className="studio-shot-refs" data-testid="studio-shot-refs">
              <span className="studio-label">参考</span>
              <div className="studio-shot-ref-row">
                {autoSlots.length === 0 ? (
                  <span className="studio-shot-ref-empty">无</span>
                ) : (
                  autoSlots.map((slot) => (
                    <div
                      key={`${slot.kind}-${slot.label}-${slot.url}`}
                      className="studio-shot-ref-slot"
                      title={slot.label}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imageUrl(slot.url)}
                        alt={slot.label}
                        className="studio-shot-ref-thumb"
                        loading="lazy"
                      />
                      <span className="studio-shot-ref-cap">
                        {slot.kind === "scene" &&
                        (projectSceneImages || []).includes(slot.url)
                          ? `${slot.label}·绑`
                          : slot.label}
                      </span>
                    </div>
                  ))
                )}
                <label className="studio-shot-ref-add" title="场景图">
                  <Icon name="plus" size={12} />
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      void (async () => {
                        try {
                          const r = await uploadImage(f, "img2img", true);
                          const qs = new URLSearchParams({
                            filename: r.filename,
                            type: "input",
                            worker: r.worker,
                          });
                          setSceneRefs((prev) => [...prev, `/api/images?${qs}`].slice(0, 4));
                        } catch {
                          /* 上传失败由全局错误条/静默;不打断主流程 */
                        }
                      })();
                    }}
                  />
                </label>
              </div>
            </div>
            {candidates.length > 0 && (
              <div className="studio-cand-row" data-testid="studio-cand-row">
                {candidates.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`studio-cand${c.is_picked ? " is-picked" : ""}${c.status === "error" ? " is-error" : ""}`}
                    disabled={busy || c.status !== "done" || !onPickCandidate}
                    title={
                      [
                        c.error || "",
                        (c as { pick_note?: string }).pick_note || "",
                        typeof (c as { face_mean?: number }).face_mean === "number"
                          ? `face=${((c as { face_mean?: number }).face_mean as number).toFixed(2)}`
                          : "",
                        `候选 ${i + 1}`,
                      ]
                        .filter(Boolean)
                        .join(" | ")
                    }
                    onClick={() => onPickCandidate?.(c.id)}
                  >
                    {c.status === "done" && c.url ? (
                      <video src={imageUrl(c.url)} muted playsInline preload="metadata" />
                    ) : (
                      <span>{c.status === "generating" ? "…" : c.status === "error" ? "!" : i + 1}</span>
                    )}
                    {c.is_picked && (
                      <span className="studio-cand-check">
                        <Icon name="check" size={10} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {shot.status === "error" || shot.error ? (
          <p className="studio-shot-error" role="alert" data-testid="studio-shot-error">
            <Icon name="alert" size={12} /> {shot.error || "选优/生成失败"}
          </p>
        ) : null}

        {/* ── 操作 ── */}
        <div className="studio-shot-actions">
          <Ripple>
            <button
              type="button"
              className={busyRender ? "btn btn-sm btn-danger" : "btn btn-sm btn-primary"}
              disabled={busy && !busyRender}
              title={busyRender ? "中止本镜渲染(断开请求并尝试中断 GPU)" : undefined}
              onClick={busyRender && onCancelRender ? onCancelRender : doRender}
            >
              <Icon name={busyRender ? "close" : "playing"} size={12} />
              {busyRender ? "中止" : "生成"}
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
      <style jsx>{`
        .shot-save-state {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          margin-left: auto;
          font-size: var(--text-aux);
          color: var(--text-muted);
          white-space: nowrap;
        }
        .shot-save-state.is-saved {
          color: var(--ok);
        }
        .shot-save-state.is-error {
          color: var(--err);
        }
        .studio-shot-ai {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          padding: var(--space-2);
          background: var(--bg-surface-3);
          border: 1px dashed var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .studio-shot-ai-row {
          display: flex;
          gap: var(--space-1);
        }
        .studio-shot-ai-row .input {
          flex: 1;
          min-width: 0;
        }
        .studio-shot-ai-row .studio-shot-skill {
          flex-shrink: 0;
          max-width: 40%;
        }
        .studio-shot-ai-error {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--err);
        }
        .studio-shot-chars {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-1);
        }
        .studio-shot-char {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: 1px var(--space-2);
          font-size: var(--text-aux);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
        }
        .studio-shot-char.is-on {
          border-color: var(--accent);
          color: var(--text-primary);
          background: var(--bg-surface-3);
        }
      `}</style>
    </article>
  );
}
