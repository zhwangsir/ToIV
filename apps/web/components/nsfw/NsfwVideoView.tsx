"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";

import {
  generateLtxT2V,
  generateLtxI2V,
  generateLtxLipsync,
  uploadImage,
  imageUrl,
  invalidateJobs,
  setNsfwIntent,
} from "@/lib/api";
import { optimizeWithAgent } from "@/lib/agents";
import type {
  LtxT2VParams,
  LtxI2VParams,
  LtxLipsyncParams,
  GenerateResponse,
} from "@/lib/types";
import {
  usePersistedGeneration,
  readFormSnapshot,
  writeFormSnapshot,
} from "@/lib/gen-persist";
import { Icon } from "@/components/ui/Icon";
import { OptimizeButton } from "@/components/ui/OptimizeButton";

type Scene = "t2v" | "i2v" | "lipsync";
type Status = "idle" | "uploading" | "optimizing" | "queued" | "sampling" | "done" | "error";

interface UploadedRef {
  filename: string;
  worker: string;
  previewUrl: string;
  name: string;
}

// 上传校验:图/音频都走后端 /api/upload(上限 20MB);扩展名白名单
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];
const AUDIO_EXT_OK = ["wav", "mp3", "m4a", "ogg"];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

// 半分辨率预设:后端 width/height 是半分辨率,2 阶段采样后上采样到目标清晰度
const RES_PRESETS = [
  { label: "480p", w: 640, h: 384 },
  { label: "720p", w: 768, h: 384 },
  { label: "1080p", w: 1024, h: 576 },
] as const;

// 时长预设:帧数 = 秒数 × 16fps + 1(含起始帧)
const DURATION_PRESETS = [
  { label: "6s", length: 97 },
  { label: "10s", length: 161 },
  { label: "15s", length: 241 },
] as const;

const DEFAULT_STEPS = 20;
const DEFAULT_CFG = 1.0;
const DEFAULT_FPS = 16;

const SCENES: { id: Scene; label: string; icon: "create" | "image" | "audio" }[] = [
  { id: "t2v", label: "文生视频", icon: "create" },
  { id: "i2v", label: "图生视频", icon: "image" },
  { id: "lipsync", label: "口型同步", icon: "audio" },
];

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

/**
 * 质量维度进度条:label + 横向条 + 数值,颜色按值分段。
 *
 * Why 单独抽组件:三段(美学/技术/对齐)结构完全相同,抽出避免重复 JSX;
 *    颜色阈值 >0.6 success / 0.4-0.6 warn / <0.4 danger 对齐后端评估语义,
 *    让用户一眼看出哪个维度拖后腿。
 */
function QualityBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const tone = value > 0.6 ? "ok" : value >= 0.4 ? "warn" : "danger";
  return (
    <div className={`quality-bar is-${tone}`}>
      <div className="quality-bar-label">{label}</div>
      <div className="quality-bar-track">
        <div className="quality-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="quality-bar-val">{pct}</div>
      <style jsx>{`
        .quality-bar {
          display: grid;
          grid-template-columns: 44px 1fr 28px;
          align-items: center;
          gap: var(--space-2);
        }
        .quality-bar-label {
          font-size: var(--text-aux);
          color: var(--text-secondary);
        }
        .quality-bar-track {
          height: 6px;
          background: var(--bg-surface-3);
          border-radius: var(--radius-full);
          overflow: hidden;
        }
        .quality-bar-fill {
          height: 100%;
          border-radius: var(--radius-full);
          transition: width var(--duration-base) var(--ease-standard);
        }
        .quality-bar-val {
          font-size: var(--text-aux);
          font-family: var(--font-mono);
          color: var(--text-muted);
          text-align: right;
        }
        .is-ok .quality-bar-fill { background: var(--ok); }
        .is-warn .quality-bar-fill { background: var(--warn); }
        .is-danger .quality-bar-fill { background: var(--err); }
      `}</style>
    </div>
  );
}

/**
 * NSFW 专区 LTX2.3 视频生成视图。
 * - 三种场景:文生视频 / 图生视频 / 口型同步
 * - 默认参数对齐后端 distilled 训练甜点档(steps=20, cfg=1.0, fps=16)
 * - SSE 进度追踪 / done / error 处理由 useGeneration hook 统一收敛(lib/useGeneration)
 */
export function NsfwVideoView() {
  const GEN_SLOT = "nsfw-video";

  // ---- 表单快照恢复 ----
  const formSnap = readFormSnapshot<{
    scene: Scene; positive: string; negative: string;
    width: number; height: number; length: number;
    useUpscale: boolean; useRife: boolean;
    seedLocked: boolean; seed: string;
  }>(GEN_SLOT);

  const [scene, setScene] = useState<Scene>(formSnap?.scene ?? "t2v");

  const [positive, setPositive] = useState(formSnap?.positive ?? "");
  const [negative, setNegative] = useState(formSnap?.negative ?? "");
  const [negOpen, setNegOpen] = useState(false);

  const [width, setWidth] = useState(formSnap?.width ?? 768);
  const [height, setHeight] = useState(formSnap?.height ?? 384);
  const [length, setLength] = useState(formSnap?.length ?? 97);

  // 步数 / CFG 走甜点档,前端只读展示,不暴露调节
  const steps = DEFAULT_STEPS;
  const cfg = DEFAULT_CFG;

  // 默认关闭 2 阶段采样/RIFE:多数环境缺 nvidia_video_super_resolution / rife 模型,
  // 先保证基础 LTX 视频能跑通;用户可在高级参数里手动开启。
  const [useUpscale, setUseUpscale] = useState(formSnap?.useUpscale ?? false);
  const [useRife, setUseRife] = useState(formSnap?.useRife ?? false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [seedLocked, setSeedLocked] = useState(formSnap?.seedLocked ?? false);
  const [seed, setSeed] = useState(formSnap?.seed ?? "");

  // 上传引用不持久化(worker 临时路径可能失效)
  const [imageUploaded, setImageUploaded] = useState<UploadedRef | null>(null);
  const [audioUploaded, setAudioUploaded] = useState<UploadedRef | null>(null);

  // submitting:generateXxx API 调用阶段(排队中);gen.isRunning:SSE 采样阶段
  const [submitting, setSubmitting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [imageDragOver, setImageDragOver] = useState(false);
  const [audioDragOver, setAudioDragOver] = useState(false);

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  // 480p 以下自动关 2 阶段采样
  useEffect(() => {
    if (width <= 640) {
      setUseUpscale(false);
    }
  }, [width]);

  // 挂载时确保 NSFW intent 开启(tab 从图像切到视频时,CreateView 卸载不会关 intent,
  // 但此处额外保底,防止其他组件意外关闭)
  useEffect(() => {
    setNsfwIntent(true);
  }, []);

  // ---- 表单快照持久化 ----
  useEffect(() => {
    writeFormSnapshot(GEN_SLOT, {
      scene, positive, negative,
      width, height, length,
      useUpscale, useRife,
      seedLocked, seed,
    });
  }, [scene, positive, negative, width, height, length, useUpscale, useRife, seedLocked, seed]);

  // ---- 持久化生成 hook(切走再切回自动恢复 + SSE 重连)----
  const gen = usePersistedGeneration({
    slot: GEN_SLOT,
    onDone: (paths) => {
      if (paths.length === 0) {
        gen.setError("生成完成但未返回视频");
        return;
      }
      invalidateJobs();
    },
  });
  const {
    start: startGen,
    reset: resetGen,
    isRunning: genRunning,
    progress: genProgress,
    status: genStatus,
    qualityWarning,
    error: genError,
  } = gen;
  const error = genError;
  const lastSeed = gen.lastSeed;

  // 图片上传(对应 i2v / lipsync 的 image 字段)
  // 必须路由到具备 LTX 模型/节点的 worker,不能走 img2img(会选到 flux 出图机)。
  const handleImageUpload = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || !IMAGE_EXT_OK.includes(fileExt(file.name))) {
      gen.setError(`「${file.name}」格式不支持(仅 jpg/png/webp)`);
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      gen.setError(`「${file.name}」超过 20MB 上限(${(file.size / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }
    setUploading(true);
    try {
      const kind = scene === "lipsync" ? "ltx_lipsync" : "ltx_i2v";
      const r = await uploadImage(file, kind);
      setImageUploaded({
        filename: r.filename,
        worker: r.worker,
        previewUrl: imageUrl(r.filename),
        name: file.name,
      });
    } catch (e) {
      gen.setError(e instanceof Error ? e.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  }, [gen, scene]);

  // 音频上传(复用 /api/upload;对应 lipsync 的 audio 字段)
  // 必须上传到 image 所在的同一 worker,否则 lipsync 生成时找不到音频文件。
  const handleAudioUpload = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("audio/") || !AUDIO_EXT_OK.includes(fileExt(file.name))) {
      gen.setError(`「${file.name}」格式不支持(仅 wav/mp3/m4a/ogg)`);
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      gen.setError(`「${file.name}」超过 20MB 上限(${(file.size / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }
    if (!imageUploaded) {
      gen.setError("请先上传参考图,再上传音频");
      return;
    }
    setUploading(true);
    try {
      const r = await uploadImage(file, "ltx_lipsync", false, imageUploaded.worker);
      setAudioUploaded({
        filename: r.filename,
        worker: r.worker,
        previewUrl: imageUrl(r.filename),
        name: file.name,
      });
    } catch (e) {
      gen.setError(e instanceof Error ? e.message : "音频上传失败");
    } finally {
      setUploading(false);
    }
  }, [gen, imageUploaded]);

  // 切换场景时重置表单(不中断进行中的生成)
  const switchScene = useCallback((s: Scene) => {
    setScene(s);
    setImageUploaded(null);
    setAudioUploaded(null);
    setUploading(false);
    setSubmitting(false);
    if (!genRunning) resetGen();
  }, [resetGen, genRunning]);

  // 主生成流程
  const handleGenerate = useCallback(async () => {
    if (!positive.trim()) return;
    if (scene === "i2v" && !imageUploaded) return;
    if (scene === "lipsync" && (!imageUploaded || !audioUploaded)) return;
    if (uploading || submitting || optimizing || genRunning) return;

    // API 调用阶段先标"排队中",startGen 内部会清空 gen 状态并切到 running
    setSubmitting(true);

    try {
      // 生成前自动调用提示词优化;失败时优雅降级,使用原提示词继续生成
      let prompt = positive.trim();
      setOptimizing(true);
      try {
        const r = await optimizeWithAgent({ prompt, kind: "video" });
        if (r.optimized) {
          prompt = r.optimized;
          setPositive(prompt);
        }
      } catch (e) {
        // 优化服务不可达时不阻塞主流程
        console.warn("视频提示词优化失败,使用原提示词:", e);
      } finally {
        setOptimizing(false);
      }

      let res: GenerateResponse;
      const base = {
        positive: prompt,
        negative: negative.trim() || undefined,
        width,
        height,
        length,
        fps: DEFAULT_FPS,
        steps,
        cfg,
        seed: seedLocked && seed ? Number(seed) : null,
        use_upscale: useUpscale,
        use_rife: useRife,
      };

      if (scene === "t2v") {
        const params: LtxT2VParams = base;
        res = await generateLtxT2V(params);
      } else if (scene === "i2v") {
        if (!imageUploaded) throw new Error("请先上传参考图");
        const params: LtxI2VParams = {
          ...base,
          image: imageUploaded.filename,
          worker: imageUploaded.worker,
        };
        res = await generateLtxI2V(params);
      } else {
        if (!imageUploaded) throw new Error("请先上传参考图");
        if (!audioUploaded) throw new Error("请先上传参考音频");
        const params: LtxLipsyncParams = {
          ...base,
          image: imageUploaded.filename,
          audio: audioUploaded.filename,
          worker: imageUploaded.worker,
        };
        res = await generateLtxLipsync(params);
      }

      // API 完成,交棒给持久化 hook 跟踪 SSE;submitting 归 false 后 busy 由 genRunning 接管
      setSubmitting(false);
      // startGen 永远 resolve(内部 catch 后走 setError),不会抛到这里
      await startGen(res);
    } catch (e) {
      // 仅 generateXxx API 调用异常会落到此
      gen.setError(e instanceof Error ? e.message : "生成失败");
      setSubmitting(false);
    }
  }, [
    positive, negative, scene, imageUploaded, audioUploaded,
    uploading, submitting, optimizing, genRunning,
    width, height, length, steps, cfg, seedLocked, seed, useUpscale, useRife,
    startGen, gen,
  ]);

  // 拖拽上传
  const handleImageDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      setImageDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void handleImageUpload(f);
    },
    [handleImageUpload],
  );
  const handleAudioDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      setAudioDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void handleAudioUpload(f);
    },
    [handleAudioUpload],
  );

  // 分辨率 / 时长预设点击
  const applyResPreset = useCallback((w: number, h: number) => {
    setWidth(w);
    setHeight(h);
  }, []);
  const applyDurationPreset = useCallback((len: number) => {
    setLength(len);
  }, []);

  // 种子操作
  const randomizeSeed = useCallback(() => {
    setSeed(String(randomSeed()));
    setSeedLocked(true);
  }, []);
  const lockLastSeed = useCallback(() => {
    if (lastSeed == null) return;
    setSeed(String(lastSeed));
    setSeedLocked(true);
  }, [lastSeed]);

  // 派生统一视图状态:把 submitting / uploading / gen 的 4 态映射回原 UI 的 6 态
  // Why:useGeneration 只有 idle/running/done/error,原 UI 区分 queued/sampling;
  //      genProgress.max>0 表示已收到首个进度分片 → sampling,否则 → queued
  const viewStatus: Status =
    error
      ? "error"
      : uploading
        ? "uploading"
        : optimizing
          ? "optimizing"
          : submitting
            ? "queued"
            : genRunning
              ? genProgress.max > 0
                ? "sampling"
                : "queued"
              : genStatus === "done"
                ? "done"
                : "idle";

  const busy = viewStatus === "uploading" || viewStatus === "optimizing" || viewStatus === "queued" || viewStatus === "sampling";
  const canGenerate =
    !busy &&
    positive.trim().length > 0 &&
    (scene === "t2v" ||
      (scene === "i2v" && !!imageUploaded) ||
      (scene === "lipsync" && !!imageUploaded && !!audioUploaded));

  const progressPct =
    genProgress.max > 0
      ? Math.min(100, Math.round((genProgress.value / genProgress.max) * 100))
      : 0;

  const stageText =
    viewStatus === "uploading"
      ? "上传中…"
      : viewStatus === "optimizing"
        ? "优化提示词中…"
        : viewStatus === "queued"
          ? "排队中…"
          : viewStatus === "sampling"
            ? genProgress.max > 0
              ? `采样中 ${genProgress.value}/${genProgress.max}`
              : "采样中…"
            : "";

  // 视频通常单产物,取第一个;后端 images 字段在 LTX 场景下返回视频路径
  const resultUrl = gen.resultPaths[0] ? imageUrl(gen.resultPaths[0]) : null;

  const secondsLabel = Math.round(length / DEFAULT_FPS);

  return (
    <div className="nsv-view">
      {/* ───── 左:视频画布 ───── */}
      <section className="nsv-canvas">
        <header className="nsv-canvas-top">
          <div className="nsv-scene-tabs" role="tablist" aria-label="视频场景">
            {SCENES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={scene === s.id}
                className={`nsv-scene-tab${scene === s.id ? " is-active" : ""}`}
                onClick={() => switchScene(s.id)}
              >
                <Icon name={s.icon} size={14} />
                {s.label}
              </button>
            ))}
          </div>
          <div className="nsv-canvas-meta">
            <span className="badge badge-accent" title="LTX2.3 distilled">
              LTX2.3
            </span>
            <span className="badge" title="半分辨率">
              {width}×{height}
            </span>
            <span className="badge" title="时长 / 帧数">
              {secondsLabel}s · {length}f
            </span>
            {lastSeed != null && (
              <span className="badge" title="上次实际种子">seed {lastSeed}</span>
            )}
          </div>
        </header>

        <div className="nsv-stage">
          {/* 空态 */}
          {!busy && !resultUrl && viewStatus !== "error" && (
            <div className="empty-state nsv-empty">
              <div className="empty-state-icon">
                <Icon name="video" size={56} strokeWidth={1.1} />
              </div>
              <div className="empty-state-title">LTX2.3 视频生成</div>
              <div className="empty-state-desc">
                {scene === "t2v"
                  ? "填写正向提示词,点击生成开始创作"
                  : scene === "i2v"
                    ? "上传参考图并填写提示词,生成动态视频"
                    : "上传人物图与参考音频,生成对口型视频"}
              </div>
            </div>
          )}

          {/* 生成中 */}
          {busy && (
            <div className="nsv-loading">
              <div className="nsv-loading-card">
                <div className="nsv-loading-orb" aria-hidden="true" />
                <div className="nsv-loading-stage">{stageText || "生成中…"}</div>
                <div className="nsv-progress">
                  <div
                    className="nsv-progress-bar"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="nsv-progress-pct">
                  {viewStatus === "sampling" && genProgress.max > 0 ? `${progressPct}%` : "—"}
                </div>
              </div>
            </div>
          )}

          {/* 结果展示 */}
          {!busy && resultUrl && (
            <div className="nsv-result-wrap">
              {/* 质量诊断卡片:done 前若收到 quality_warning(total < 0.65)则展示
                  Why 放结果上方:让用户在看出片不理想时第一时间拿到"为什么 + 怎么改" */}
              {qualityWarning && (
                <div className="quality-card">
                  <div className="quality-header">
                    <span className="quality-header-icon">
                      <Icon name="warning" size={18} />
                    </span>
                    <span className="quality-title">质量诊断</span>
                    <span className="quality-score">
                      {qualityWarning.quality_score}/100
                    </span>
                  </div>
                  {/* 三段式进度条:美学 / 技术 / 对齐 */}
                  <div className="quality-bars">
                    <QualityBar label="美学" value={qualityWarning.aesthetic} />
                    <QualityBar label="技术" value={qualityWarning.technical} />
                    <QualityBar label="对齐" value={qualityWarning.prompt_alignment} />
                  </div>
                  {/* 问题清单 */}
                  {qualityWarning.issues.length > 0 && (
                    <ul className="quality-issues">
                      {qualityWarning.issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  {/* 应用建议提示词:一键预填到正向框,降低改进成本 */}
                  {qualityWarning.suggested_prompt && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm quality-apply"
                      onClick={() =>
                        setPositive(qualityWarning.suggested_prompt as string)
                      }
                    >
                      <Icon name="sparkles" size={14} />
                      应用建议提示词
                    </button>
                  )}
                  {/* 评估降级:模型自身失败,数据可能不全 */}
                  {qualityWarning.degraded && (
                    <div className="quality-degraded">
                      评估降级(模型未能完全分析)
                    </div>
                  )}
                </div>
              )}
              <div className="nsv-result">
                <video
                  src={resultUrl}
                  controls
                  autoPlay
                  loop
                  playsInline
                  className="nsv-video"
                />
              </div>
            </div>
          )}

          {/* 错误态 */}
          {!busy && viewStatus === "error" && error && (
            <div className="empty-state nsv-error-state">
              <div className="empty-state-icon" style={{ color: "var(--err)" }}>
                <Icon name="error" size={48} strokeWidth={1.4} />
              </div>
              <div className="empty-state-title">生成失败</div>
              <div className="empty-state-desc">{error}</div>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: "var(--space-3)" }}
                onClick={() => resetGen()}
              >
                重试
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ───── 右:参数面板 ───── */}
      <aside className="nsv-panel">
        <div className="nsv-panel-scroll">
          {/* 提示词 */}
          <div className="card nsv-section">
            <div className="nsv-section-head">
              <label className="nsv-label" htmlFor="nsv-positive">正向提示词</label>
              <OptimizeButton
                prompt={positive}
                kind="video"
                onOptimized={(text) => setPositive(text)}
                disabled={busy}
              />
            </div>
            <textarea
              id="nsv-positive"
              className="input nsv-textarea"
              placeholder="描述你想要生成的视频画面…"
              rows={4}
              value={positive}
              onChange={(e) => setPositive(e.target.value)}
            />
          </div>

          {/* 负向提示词(可折叠) */}
          <div className="card nsv-section">
            <button
              type="button"
              className="nsv-collapse-head"
              onClick={() => setNegOpen((v) => !v)}
              aria-expanded={negOpen}
            >
              <span className="nsv-label">负向提示词</span>
              <span className={`nsv-chevron${negOpen ? " is-open" : ""}`}>‹</span>
            </button>
            {negOpen && (
              <textarea
                className="input nsv-textarea"
                placeholder="不想出现的元素,如 lowres, blurry, watermark…"
                rows={3}
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
                style={{ marginTop: "var(--space-2)" }}
              />
            )}
          </div>

          {/* 图片上传(i2v / lipsync 显示) */}
          {(scene === "i2v" || scene === "lipsync") && (
            <div className="card nsv-section">
              <div className="nsv-label">参考图</div>
              <div
                className={`nsv-upload${imageDragOver ? " is-drag" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setImageDragOver(true);
                }}
                onDragLeave={() => setImageDragOver(false)}
                onDrop={handleImageDrop}
                onClick={() => imageInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    imageInputRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="上传参考图,按 Enter 或空格激活"
              >
                {imageUploaded ? (
                  <div className="nsv-upload-preview">
                    <img src={imageUploaded.previewUrl} alt={imageUploaded.name} />
                    <div className="nsv-upload-meta">
                      <span className="nsv-upload-name">{imageUploaded.name}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm nsv-upload-clear"
                        onClick={(e) => {
                          e.stopPropagation();
                          setImageUploaded(null);
                        }}
                      >
                        <Icon name="close" size={12} /> 清除
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="nsv-upload-empty">
                    <Icon name="upload" size={22} strokeWidth={1.5} />
                    <div>点击或拖拽图片到此处</div>
                    <div className="nsv-upload-hint">支持 PNG / JPG / WebP</div>
                  </div>
                )}
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => void handleImageUpload(e.target.files?.[0])}
                />
              </div>
            </div>
          )}

          {/* 音频上传(仅 lipsync) */}
          {scene === "lipsync" && (
            <div className="card nsv-section">
              <div className="nsv-label">参考音频</div>
              <div
                className={`nsv-upload${audioDragOver ? " is-drag" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setAudioDragOver(true);
                }}
                onDragLeave={() => setAudioDragOver(false)}
                onDrop={handleAudioDrop}
                onClick={() => audioInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    audioInputRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="上传参考音频,按 Enter 或空格激活"
              >
                {audioUploaded ? (
                  <div className="nsv-upload-preview nsv-audio-preview">
                    <div className="nsv-audio-icon">
                      <Icon name="audio" size={20} />
                    </div>
                    <div className="nsv-upload-meta">
                      <span className="nsv-upload-name">{audioUploaded.name}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm nsv-upload-clear"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAudioUploaded(null);
                        }}
                      >
                        <Icon name="close" size={12} /> 清除
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="nsv-upload-empty">
                    <Icon name="audio" size={22} strokeWidth={1.5} />
                    <div>点击或拖拽音频到此处</div>
                    <div className="nsv-upload-hint">支持 WAV / MP3 / M4A / OGG</div>
                  </div>
                )}
                <input
                  ref={audioInputRef}
                  type="file"
                  accept="audio/*"
                  hidden
                  onChange={(e) => void handleAudioUpload(e.target.files?.[0])}
                />
              </div>
            </div>
          )}

          {/* 分辨率预设 */}
          <div className="card nsv-section">
            <div className="nsv-label">分辨率预设(半分辨率)</div>
            <div className="nsv-preset-grid">
              {RES_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`nsv-preset-btn${width === p.w && height === p.h ? " is-active" : ""}`}
                  onClick={() => applyResPreset(p.w, p.h)}
                >
                  <span className="nsv-preset-title">{p.label}</span>
                  <span className="nsv-preset-sub">{p.w}×{p.h}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 时长预设 */}
          <div className="card nsv-section">
            <div className="nsv-label">时长预设(16fps)</div>
            <div className="nsv-preset-grid">
              {DURATION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`nsv-preset-btn${length === p.length ? " is-active" : ""}`}
                  onClick={() => applyDurationPreset(p.length)}
                >
                  <span className="nsv-preset-title">{p.label}</span>
                  <span className="nsv-preset-sub">{p.length} 帧</span>
                </button>
              ))}
            </div>
          </div>

          {/* 高级参数(可折叠) */}
          <div className="card nsv-section">
            <button
              type="button"
              className="nsv-collapse-head"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              <span className="nsv-label">高级参数</span>
              <span className={`nsv-chevron${advancedOpen ? " is-open" : ""}`}>‹</span>
            </button>
            {advancedOpen && (
              <div className="nsv-advanced-body">
                {/* 2 阶段采样 */}
                <div className="nsv-toggle-row">
                  <div className="nsv-toggle-text">
                    <div className="nsv-toggle-title">2 阶段采样</div>
                    <div className="nsv-toggle-desc">
                      半分辨率采样后上采样到目标清晰度
                    </div>
                  </div>
                  <label className="nsv-switch">
                    <input
                      type="checkbox"
                      checked={useUpscale}
                      onChange={(e) => setUseUpscale(e.target.checked)}
                      disabled={width <= 640}
                    />
                    <span className="nsv-switch-track" />
                  </label>
                </div>
                {width <= 640 && (
                  <div className="nsv-field-hint">
                    <Icon name="warning" size={11} /> 480p 分辨率过低,自动关闭
                  </div>
                )}

                {/* RIFE 插帧 */}
                <div className="nsv-toggle-row">
                  <div className="nsv-toggle-text">
                    <div className="nsv-toggle-title">RIFE 插帧</div>
                    <div className="nsv-toggle-desc">
                      16fps → 32fps 插帧补帧,运动更流畅
                    </div>
                  </div>
                  <label className="nsv-switch">
                    <input
                      type="checkbox"
                      checked={useRife}
                      onChange={(e) => setUseRife(e.target.checked)}
                    />
                    <span className="nsv-switch-track" />
                  </label>
                </div>

                {/* 种子 */}
                <div className="nsv-seed-head">
                  <label className="nsv-label" htmlFor="nsv-seed">种子</label>
                  <label className="nsv-lock-toggle">
                    <input
                      type="checkbox"
                      checked={seedLocked}
                      onChange={(e) => setSeedLocked(e.target.checked)}
                    />
                    <span>固定</span>
                  </label>
                </div>
                <div className="nsv-seed-row">
                  <input
                    id="nsv-seed"
                    type="number"
                    className="input"
                    placeholder="随机"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    disabled={!seedLocked}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={randomizeSeed}
                    title="生成随机种子"
                  >
                    <Icon name="refresh" size={13} />
                  </button>
                </div>
                {lastSeed != null && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm nsv-locklast"
                    onClick={lockLastSeed}
                  >
                    锁定上次种子({lastSeed})
                  </button>
                )}

                {/* 只读甜点参数 */}
                <div className="nsv-readonly-grid">
                  <div className="nsv-readonly-item">
                    <span className="nsv-readonly-label">采样步数</span>
                    <span className="nsv-readonly-val">{steps}</span>
                  </div>
                  <div className="nsv-readonly-item">
                    <span className="nsv-readonly-label">CFG</span>
                    <span className="nsv-readonly-val">{cfg.toFixed(1)}</span>
                  </div>
                  <div className="nsv-readonly-item">
                    <span className="nsv-readonly-label">FPS</span>
                    <span className="nsv-readonly-val">{DEFAULT_FPS}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 生成按钮(固定底部) */}
        <div className="nsv-panel-foot">
          <button
            type="button"
            className="btn btn-primary nsv-generate-btn"
            onClick={handleGenerate}
            disabled={!canGenerate}
          >
            {busy ? (
              <>
                <Icon name="loading" size={16} />
                {stageText || "生成中…"}
              </>
            ) : (
              <>
                <Icon name="video" size={16} />
                生成视频
              </>
            )}
          </button>
          {error && !busy && (
            <div className="nsv-foot-error">
              <Icon name="error" size={12} /> {error}
            </div>
          )}
        </div>
      </aside>

      <style jsx>{`
        .nsv-view {
          display: grid;
          grid-template-columns: 1fr var(--rightpanel-w);
          height: 100%;
          min-height: 100vh;
          background: var(--bg-canvas);
        }

        /* ───── 左:画布 ───── */
        .nsv-canvas {
          display: flex;
          flex-direction: column;
          min-width: 0;
          border-right: 1px solid var(--border-subtle);
          background:
            radial-gradient(
              120% 80% at 50% 0%,
              color-mix(in oklch, var(--accent) 5%, transparent),
              transparent 60%
            ),
            var(--bg-canvas);
        }
        .nsv-canvas-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
          flex-shrink: 0;
        }
        .nsv-scene-tabs {
          display: inline-flex;
          gap: 2px;
          padding: var(--space-1);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
        }
        .nsv-scene-tab {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-3);
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-badge);
          color: var(--text-secondary);
          font-size: var(--text-aux);
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .nsv-scene-tab:hover {
          background: var(--bg-surface-2);
        }
        .nsv-scene-tab:active {
          background: var(--bg-surface-3);
        }
        .nsv-scene-tab.is-active {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
          color: var(--accent);
        }
        .nsv-canvas-meta {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        /* 画布舞台 */
        .nsv-stage {
          position: relative;
          flex: 1;
          min-height: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-5);
        }
        .nsv-empty {
          width: 100%;
          max-width: 480px;
        }

        /* 加载态 */
        .nsv-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
        }
        .nsv-loading-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-5);
        }
        .nsv-loading-orb {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: radial-gradient(
            circle at 35% 35%,
            var(--accent-hover),
            var(--accent) 60%,
            transparent 70%
          );
          filter: blur(6px);
          opacity: 0.85;
          animation: nsv-orb-pulse 2s ease-in-out infinite;
        }
        @keyframes nsv-orb-pulse {
          0%, 100% { transform: scale(1); opacity: 0.7; }
          50% { transform: scale(1.18); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .nsv-loading-orb { animation: none; }
        }
        .nsv-loading-stage {
          font-size: var(--text-body);
          color: var(--text-secondary);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }
        .nsv-progress {
          width: 280px;
          height: 4px;
          background: var(--bg-surface-2);
          border-radius: var(--radius-full);
          overflow: hidden;
        }
        .nsv-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, var(--accent), var(--accent-soft));
          border-radius: var(--radius-full);
          transition: width var(--duration-base) var(--ease-standard);
        }
        .nsv-progress-pct {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }

        /* 结果展示 */
        .nsv-result-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-3);
          width: 100%;
          height: 100%;
          min-height: 0;
        }
        .nsv-result-wrap .nsv-result {
          flex: 1;
          min-height: 0;
        }
        .nsv-result {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
        }
        .nsv-video {
          max-width: 100%;
          max-height: calc(100vh - 140px);
          border-radius: var(--radius-panel);
          overflow: hidden;
          border: 1px solid var(--border-strong);
          box-shadow: var(--shadow-lg),
            0 0 60px -20px var(--accent-glow);
          background: var(--bg-surface-1);
        }
        .nsv-error-state { max-width: 420px; }

        /* ───── 质量诊断卡片 ───── */
        .quality-card {
          width: 100%;
          max-width: 560px;
          flex-shrink: 0;
          padding: var(--space-3) var(--space-4);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-strong);
          border-left: 3px solid var(--warn);
          border-radius: var(--radius-control);
          box-shadow: var(--shadow-md);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .quality-header {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .quality-header-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--warn);
        }
        .quality-title {
          font-size: var(--text-body);
          font-weight: 600;
          color: var(--text-primary);
          letter-spacing: 0.01em;
        }
        .quality-score {
          margin-left: auto;
          padding: 2px var(--space-2);
          background: var(--warn-soft);
          border: 1px solid color-mix(in oklch, var(--warn) 35%, transparent);
          border-radius: var(--radius-full);
          font-size: var(--text-aux);
          font-family: var(--font-mono);
          font-weight: 600;
          color: var(--warn);
        }
        .quality-bars {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .quality-issues {
          margin: 0;
          padding: var(--space-2) 0 var(--space-2) var(--space-4);
          list-style: disc;
          border-top: 1px solid var(--border-subtle);
        }
        .quality-issues li {
          font-size: var(--text-aux);
          line-height: 1.6;
          color: var(--text-secondary);
          margin-bottom: var(--space-1);
        }
        .quality-issues li:last-child {
          margin-bottom: 0;
        }
        .quality-apply {
          align-self: flex-start;
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
        }
        .quality-degraded {
          padding: var(--space-1) var(--space-2);
          background: var(--err-soft);
          border: 1px solid color-mix(in oklch, var(--err) 30%, transparent);
          border-radius: var(--radius-badge);
          font-size: var(--text-aux);
          color: var(--err);
        }

        /* ───── 右:参数面板 ───── */
        .nsv-panel {
          display: flex;
          flex-direction: column;
          background: var(--bg-surface-1);
          min-height: 0;
        }
        .nsv-panel-scroll {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-3);
        }
        .nsv-panel-scroll::-webkit-scrollbar { width: 8px; }
        .nsv-panel-scroll::-webkit-scrollbar-track { background: transparent; }
        .nsv-panel-scroll::-webkit-scrollbar-thumb {
          background: var(--border-strong);
          border-radius: var(--radius-full);
        }
        .nsv-panel-scroll::-webkit-scrollbar-thumb:hover {
          background: var(--text-muted);
        }

        .nsv-section {
          padding: var(--space-3);
        }
        .nsv-section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .nsv-label {
          display: block;
          font-size: var(--text-aux);
          font-weight: 500;
          color: var(--text-secondary);
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }
        .nsv-textarea {
          min-height: 90px;
          font-size: var(--text-body);
          line-height: 1.5;
          margin-top: var(--space-1);
        }

        /* 折叠头 */
        .nsv-collapse-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: calc(100% + 2 * var(--space-2));
          margin: calc(-1 * var(--space-1)) calc(-1 * var(--space-2));
          padding: var(--space-1) var(--space-2);
          background: transparent;
          border: none;
          border-radius: var(--radius-control);
          cursor: pointer;
          color: inherit;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .nsv-collapse-head:hover {
          background: var(--bg-surface-2);
        }
        .nsv-collapse-head:active {
          background: var(--bg-surface-3);
        }
        .nsv-chevron {
          color: var(--text-muted);
          font-size: var(--text-body);
          transform: rotate(-90deg);
          transition: transform var(--duration-fast) var(--ease-standard);
        }
        .nsv-chevron.is-open {
          transform: rotate(90deg);
        }

        /* 上传区 */
        .nsv-upload {
          margin-top: var(--space-2);
          border: 1px dashed var(--border-strong);
          border-radius: var(--radius-control);
          background: var(--bg-surface-2);
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
          overflow: hidden;
        }
        .nsv-upload:hover,
        .nsv-upload.is-drag {
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .nsv-upload:active {
          border-color: var(--accent-hover);
        }
        .nsv-upload-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-1);
          padding: var(--space-4);
          color: var(--text-muted);
          font-size: var(--text-aux);
          text-align: center;
        }
        .nsv-upload-hint {
          font-size: var(--text-label);
          color: var(--text-muted);
          opacity: 0.7;
        }
        .nsv-upload-preview {
          display: flex;
          gap: var(--space-2);
          padding: var(--space-2);
          align-items: center;
        }
        .nsv-upload-preview img {
          width: 64px;
          height: 64px;
          object-fit: cover;
          border-radius: var(--radius-badge);
          border: 1px solid var(--border-subtle);
        }
        .nsv-audio-preview {
          gap: var(--space-2);
        }
        .nsv-audio-icon {
          width: 64px;
          height: 64px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          color: var(--accent);
          flex-shrink: 0;
        }
        .nsv-upload-meta {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          min-width: 0;
          flex: 1;
        }
        .nsv-upload-name {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsv-upload-clear {
          align-self: flex-start;
          color: var(--err);
        }

        /* 预设网格 */
        .nsv-preset-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: var(--space-1);
          margin-top: var(--space-2);
        }
        .nsv-preset-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          padding: var(--space-2) var(--space-1);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          color: var(--text-secondary);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .nsv-preset-btn:hover {
          background: var(--bg-surface-3);
          border-color: var(--border-strong);
        }
        .nsv-preset-btn:active {
          border-color: var(--text-muted);
        }
        .nsv-preset-btn.is-active {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
          color: var(--accent);
        }
        .nsv-preset-title {
          font-size: var(--text-aux);
          font-weight: 600;
        }
        .nsv-preset-sub {
          font-size: var(--text-label);
          font-family: var(--font-mono);
          opacity: 0.75;
        }

        /* 高级参数 */
        .nsv-advanced-body {
          margin-top: var(--space-2);
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .nsv-toggle-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .nsv-toggle-text {
          min-width: 0;
          flex: 1;
        }
        .nsv-toggle-title {
          font-size: var(--text-aux);
          color: var(--text-primary);
          font-weight: 500;
        }
        .nsv-toggle-desc {
          font-size: var(--text-label);
          color: var(--text-muted);
          margin-top: 2px;
        }
        .nsv-field-hint {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-label);
          color: var(--text-muted);
          margin-top: calc(-1 * var(--space-1));
        }

        /* 自定义开关 */
        .nsv-switch {
          position: relative;
          display: inline-block;
          width: 36px;
          height: 20px;
          flex-shrink: 0;
          margin-top: 2px;
        }
        .nsv-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .nsv-switch-track {
          position: absolute;
          inset: 0;
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          transition: background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .nsv-switch-track::before {
          content: "";
          position: absolute;
          top: 2px;
          left: 2px;
          width: 14px;
          height: 14px;
          background: var(--text-secondary);
          border-radius: 50%;
          transition: transform var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .nsv-switch:hover .nsv-switch-track {
          border-color: var(--border-strong);
        }
        .nsv-switch input:checked + .nsv-switch-track {
          background: var(--accent);
          border-color: var(--accent);
        }
        .nsv-switch input:checked + .nsv-switch-track::before {
          transform: translateX(16px);
          background: var(--text-on-accent);
        }
        .nsv-switch input:focus-visible + .nsv-switch-track {
          outline: 1px solid var(--accent);
          outline-offset: 2px;
        }
        .nsv-switch input:disabled + .nsv-switch-track {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* 种子 */
        .nsv-seed-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .nsv-lock-toggle {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-aux);
          color: var(--text-secondary);
          cursor: pointer;
        }
        .nsv-seed-row {
          display: flex;
          gap: var(--space-1);
          margin-top: var(--space-1);
        }
        .nsv-locklast {
          margin-top: var(--space-2);
          width: 100%;
          color: var(--accent);
        }

        /* 只读甜点参数 */
        .nsv-readonly-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: var(--space-1);
          padding-top: var(--space-2);
          margin-top: var(--space-1);
          border-top: 1px solid var(--border-subtle);
        }
        .nsv-readonly-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          padding: var(--space-1) 0;
          background: var(--bg-surface-2);
          border-radius: var(--radius-badge);
        }
        .nsv-readonly-label {
          font-size: var(--text-label);
          color: var(--text-muted);
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }
        .nsv-readonly-val {
          font-size: var(--text-body);
          color: var(--accent);
          font-family: var(--font-mono);
          font-weight: 600;
        }

        /* 底部生成按钮 */
        .nsv-panel-foot {
          flex-shrink: 0;
          padding: var(--space-3);
          border-top: 1px solid var(--border-subtle);
          background: var(--bg-surface-1);
        }
        .nsv-generate-btn {
          width: 100%;
          padding: var(--space-3) var(--space-4);
          font-size: var(--text-section);
          font-weight: 600;
          border-radius: var(--radius-control);
          box-shadow: 0 4px 18px -6px color-mix(in oklch, var(--accent) 50%, transparent);
          transition: background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .nsv-generate-btn:not(:disabled):hover {
          box-shadow: 0 6px 24px -6px color-mix(in oklch, var(--accent) 65%, transparent);
        }
        .nsv-generate-btn:not(:disabled):active {
          box-shadow: 0 2px 10px -6px color-mix(in oklch, var(--accent) 50%, transparent);
        }
        .nsv-foot-error {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          margin-top: var(--space-2);
          font-size: var(--text-aux);
          color: var(--err);
        }

        /* 移动端:堆叠 */
        @media (max-width: 880px) {
          .nsv-view {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(360px, 60vh) auto;
          }
          .nsv-canvas {
            border-right: none;
            border-bottom: 1px solid var(--border-subtle);
          }
          .nsv-video {
            max-height: calc(60vh - 140px);
          }
        }
      `}</style>
    </div>
  );
}
