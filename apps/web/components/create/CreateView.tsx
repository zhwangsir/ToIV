"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";

import {
  listModels,
  listStylePresets,
  generateTxt2img,
  generateImg2img,
  uploadImage,
  imageUrl,
  invalidateJobs,
  setNsfwIntent,
} from "@/lib/api";
import type {
  Txt2ImgParams,
  Img2ImgGenParams,
  ModelsResponse,
  GenerateResponse,
  StylePreset,
  CheckpointTag,
} from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import {
  usePersistedGeneration,
  readFormSnapshot,
  writeFormSnapshot,
} from "@/lib/gen-persist";

type Mode = "txt2img" | "img2img";
type Status = "idle" | "uploading" | "queued" | "sampling" | "done" | "error";

interface ResultImage {
  path: string;
  url: string;
}

interface UploadedRef {
  filename: string;
  worker: string;
  previewUrl: string;
  name: string;
}

interface ProgressInfo {
  value: number;
  max: number;
}

const SIZE_PRESETS = [
  { label: "512²", w: 512, h: 512 },
  { label: "768²", w: 768, h: 768 },
  { label: "1024²", w: 1024, h: 1024 },
] as const;

const DEFAULT_STEPS = 25;
const DEFAULT_CFG = 1.0;
const DEFAULT_SAMPLER = "euler";
const DEFAULT_SCHEDULER = "simple";
const DENOOSE_DEFAULT = 0.55;

const MODEL_LABELS: Record<string, { label: string; tag: string }> = {
  "flux2_dev_fp8mixed.safetensors": { label: "FLUX.2 Dev", tag: "旗舰" },
  "flux-2-klein-4b.safetensors": { label: "FLUX.2 Klein 4B", tag: "极速" },
  "qwen_image_fp8_e4m3fn.safetensors": { label: "Qwen-Image", tag: "中文" },
  "z_image_turbo_bf16.safetensors": { label: "z-Image Turbo", tag: "8步" },
  "majicMIX realistic 麦橘写实_v7.safetensors": { label: "麦橘写实 v7", tag: "写实" },
  "waiIllustriousSDXL_v170.safetensors": { label: "WAI Illustrious v1.7", tag: "动漫" },
  "noobaiXL_vpred10.safetensors": { label: "NoobAI XL vPred", tag: "动漫" },
  "ponyDiffusionV6XL_v6StartWithThisOne.safetensors": { label: "Pony Diffusion V6 XL", tag: "动漫" },
};

function modelLabel(name: string): string {
  return MODEL_LABELS[name]?.label ?? name.replace(/\.safetensors$/, "").replace(/\.[^.]+$/, "").replace(/_/g, " ").slice(0, 42);
}
function modelTag(name: string): string | null {
  return MODEL_LABELS[name]?.tag ?? null;
}

function isNextgenCkpt(ckpt: string): boolean {
  const n = ckpt.toLowerCase();
  return n.includes("flux2") || n.includes("qwen_image") || n.includes("z_image") || n.includes("flux-2-klein");
}

function randomSeed(): number {
  // ComfyUI 习惯:0 ~ 2^32-1
  return Math.floor(Math.random() * 0xffffffff);
}

export function CreateView({
  nsfw = false,
  defaultModel,
}: {
  nsfw?: boolean;
  defaultModel?: string;
} = {}) {
  const genSlot = nsfw ? "nsfw-create" : "create";

  // ---- 模型列表 ----
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // ---- 风格预设 ----
  const [presets, setPresets] = useState<StylePreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);

  // ---- 表单状态(从 sessionStorage 恢复)----
  const formSnap = readFormSnapshot<{
    mode: Mode; positive: string; negative: string;
    ckptName: string; width: number; height: number; sizeCustom: boolean;
    steps: number; cfg: number; sampler: string; scheduler: string;
    seedLocked: boolean; seed: string; batchSize: number; denoise: number;
    stylePreset: string | null;
  }>(genSlot);

  const [mode, setMode] = useState<Mode>(formSnap?.mode ?? "txt2img");
  const [positive, setPositive] = useState(formSnap?.positive ?? "");
  const [negative, setNegative] = useState(formSnap?.negative ?? "");
  const [negOpen, setNegOpen] = useState(false);

  const [ckptName, setCkptName] = useState(formSnap?.ckptName ?? "");
  const [width, setWidth] = useState(formSnap?.width ?? 1024);
  const [height, setHeight] = useState(formSnap?.height ?? 1024);
  const [sizeCustom, setSizeCustom] = useState(formSnap?.sizeCustom ?? false);
  const [steps, setSteps] = useState(formSnap?.steps ?? DEFAULT_STEPS);
  const [cfg, setCfg] = useState(formSnap?.cfg ?? DEFAULT_CFG);
  const [sampler, setSampler] = useState(formSnap?.sampler ?? "");
  const [scheduler, setScheduler] = useState(formSnap?.scheduler ?? "");
  const [seedLocked, setSeedLocked] = useState(formSnap?.seedLocked ?? false);
  const [seed, setSeed] = useState<string>(formSnap?.seed ?? "");
  const [batchSize, setBatchSize] = useState(formSnap?.batchSize ?? 1);
  const [denoise, setDenoise] = useState(formSnap?.denoise ?? DENOOSE_DEFAULT);
  const [activePreset, setActivePreset] = useState<string | null>(formSnap?.stylePreset ?? null);

  // ---- 图生图上传(不持久化,因 worker 临时路径可能失效)----
  const [uploaded, setUploaded] = useState<UploadedRef | null>(null);

  // ---- 生成状态(持久化:切走再切回自动恢复 + SSE 重连)----
  const gen = usePersistedGeneration({
    slot: genSlot,
    onDone: () => invalidateJobs(),
  });

  // 派生:从 gen.status + progress 映射到本视图的 6 态 Status
  const [uploading, setUploading] = useState(false);
  const status: Status = uploading
    ? "uploading"
    : gen.status === "running"
      ? gen.progress.max > 0 ? "sampling" : "queued"
      : gen.status === "done" ? "done"
      : gen.status === "error" ? "error"
      : "idle";

  const progress: ProgressInfo | null =
    gen.status === "running" && gen.progress.max > 0 ? gen.progress : null;
  const results: ResultImage[] = gen.resultPaths.map((p) => ({ path: p, url: imageUrl(p) }));
  const error = gen.error;
  const lastSeed = gen.lastSeed;

  const [activeIdx, setActiveIdx] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 去重:后端可能返回同名文件(不同子目录 basename 相同),避免 <option key> 重复告警
  const ckptOptions: string[] = useMemo(() => Array.from(new Set(models?.checkpoints ?? [])), [models?.checkpoints]);
  const samplerOptions: string[] = useMemo(() => Array.from(new Set(models?.samplers ?? [])), [models?.samplers]);
  const schedulerOptions: string[] = useMemo(() => Array.from(new Set(models?.schedulers ?? [])), [models?.schedulers]);

  // ---- 拉取模型列表 + 风格预设 ----
  // nsfw 模式:设置 X-NSFW 头,使后端返回 NSFW 模型。
  // 注意:不在卸载时关闭 intent —— /nsfw 页面内 tab 切换(图像↔视频)会卸载 CreateView,
  // 若关闭 intent 会导致 NsfwVideoView 的 API 请求丢失 X-NSFW header → 403。
  // intent 的生命周期由父 NsfwView 管理(挂载时开,卸载时关)。
  useEffect(() => {
    let cancelled = false;
    if (nsfw) setNsfwIntent(true);
    setModelsLoading(true);
    listModels()
      .then((data) => {
        if (cancelled) return;
        setModels(data);
        const ckpts = data.checkpoints ?? [];
        const def = data.modes?.image?.default ?? null;
        const initialCkpt = def && ckpts.includes(def) ? def : ckpts[0] ?? "";
        setCkptName((prev) => prev || initialCkpt);
        const samps = data.samplers ?? [];
        setSampler((s) => s || (samps.includes(DEFAULT_SAMPLER) ? DEFAULT_SAMPLER : samps[0] || "euler"));
        const schs = data.schedulers ?? [];
        setScheduler((s) => s || (schs.includes(DEFAULT_SCHEDULER) ? DEFAULT_SCHEDULER : schs[0] || "normal"));
      })
      .catch((e) => {
        if (cancelled) return;
        setModelsError(e instanceof Error ? e.message : "加载模型列表失败");
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    listStylePresets()
      .then((data) => { if (!cancelled) setPresets(data); })
      .catch(() => { if (!cancelled) setPresets([]); })
      .finally(() => { if (!cancelled) setPresetsLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [nsfw]);

  // ckpt 切换时自动适配 CFG/采样器/步数(次世代模型强制 CFG≈1)
  useEffect(() => {
    if (!ckptName) return;
    if (isNextgenCkpt(ckptName)) {
      setCfg((c) => (c > 2.0 ? DEFAULT_CFG : c));
      setSteps((st) => (st > 35 ? 28 : st));
    } else {
      setCfg((c) => (c <= 1.5 ? 5.5 : c));
    }
  }, [ckptName]);

  // 用户手动修改参数时清除预设绑定(避免误导)
  const manualChange = useCallback(() => {
    setActivePreset(null);
  }, []);

  // 选择风格预设时自动应用参数
  const applyStylePreset = useCallback((preset: StylePreset) => {
    if (ckptOptions.includes(preset.ckpt_name)) {
      setCkptName(preset.ckpt_name);
    }
    setWidth(preset.width);
    setHeight(preset.height);
    const isStandardSize = [512, 768, 1024].includes(preset.width) && preset.width === preset.height;
    setSizeCustom(!isStandardSize);
    setActivePreset(preset.id);
  }, [ckptOptions]);

  const clearStylePreset = useCallback(() => {
    setActivePreset(null);
  }, []);

  // 外部传入默认底模(如 NSFW 推荐模型下载完成后自动切到该模型)
  useEffect(() => {
    if (!defaultModel || !ckptOptions.includes(defaultModel)) return;
    if (ckptName !== defaultModel) {
      setCkptName(defaultModel);
    }
  }, [defaultModel, ckptOptions, ckptName]);

  // ---- 表单快照持久化(每次表单变化时写入 sessionStorage)----
  useEffect(() => {
    writeFormSnapshot(genSlot, {
      mode, positive, negative, ckptName,
      width, height, sizeCustom, steps, cfg,
      sampler, scheduler, seedLocked, seed, batchSize, denoise,
      stylePreset: activePreset,
    });
  }, [
    genSlot, mode, positive, negative, ckptName,
    width, height, sizeCustom, steps, cfg,
    sampler, scheduler, seedLocked, seed, batchSize, denoise, activePreset,
  ]);

  // ---- 主生成流程 ----
  const handleGenerate = useCallback(async () => {
    if (!positive.trim() || !ckptName) return;
    if (mode === "img2img" && !uploaded) return;
    if (gen.isRunning || uploading) return;

    try {
      let res: GenerateResponse;
      if (mode === "txt2img") {
        const params: Txt2ImgParams = {
          positive: positive.trim(),
          negative: negative.trim(),
          ckpt_name: ckptName,
          width,
          height,
          steps,
          cfg,
          sampler,
          scheduler,
          seed: seedLocked && seed ? Number(seed) : null,
          batch_size: batchSize,
          ...(activePreset ? { style_preset: activePreset } : {}),
        };
        res = await generateTxt2img(params);
      } else {
        if (!uploaded) throw new Error("请先上传参考图");
        const params: Img2ImgGenParams = {
          positive: positive.trim(),
          negative: negative.trim(),
          ckpt_name: ckptName,
          image: uploaded.filename,
          worker: uploaded.worker,
          denoise,
          steps,
          cfg,
          sampler,
          scheduler,
          seed: seedLocked && seed ? Number(seed) : null,
          ...(activePreset ? { style_preset: activePreset } : {}),
        };
        res = await generateImg2img(params);
      }

      setActiveIdx(0);
      // 启动持久化跟踪(SSE 自动管理,切走再切回自动重连)
      await gen.start(res);
    } catch (e) {
      // 前置 API 调用失败(generateTxt2img / generateImg2img)
      gen.setError(e instanceof Error ? e.message : "生成请求失败");
    }
  }, [
    positive, negative, ckptName, mode, uploaded, gen, uploading,
    width, height, steps, cfg, sampler, scheduler, seedLocked, seed, batchSize, denoise, activePreset,
  ]);

  // ---- 图生图上传 ----
  const handleFileChange = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (mode !== "img2img") return;
      setUploading(true);
      try {
        const r = await uploadImage(file, "img2img");
        setUploaded({
          filename: r.filename,
          worker: r.worker,
          previewUrl: imageUrl(r.filename),
          name: file.name,
        });
      } catch (e) {
        gen.setError(e instanceof Error ? e.message : "上传失败");
      } finally {
        setUploading(false);
      }
    },
    [mode, gen],
  );

  // ---- 拖拽上传 ----
  const [dragOver, setDragOver] = useState(false);
  const handleDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f && f.type.startsWith("image/")) void handleFileChange(f);
    },
    [handleFileChange],
  );

  // ---- 尺寸预设点击 ----
  const applyPreset = useCallback((w: number, h: number) => {
    setWidth(w);
    setHeight(h);
    setSizeCustom(false);
  }, []);

  // ---- 切换模式时清理(不中断进行中的生成)----
  const switchMode = useCallback((m: Mode) => {
    setMode(m);
    // 仅在非生成中时清错误
    if (!gen.isRunning) gen.reset();
  }, [gen]);

  // ---- 锁定上一次的实际种子 ----
  const lockLastSeed = useCallback(() => {
    if (lastSeed == null) return;
    setSeed(String(lastSeed));
    setSeedLocked(true);
  }, [lastSeed]);

  // ---- 随机种子 ----
  const randomizeSeed = useCallback(() => {
    setSeed(String(randomSeed()));
    setSeedLocked(true);
  }, []);

  const busy =
    status === "uploading" || status === "queued" || status === "sampling";
  const canGenerate =
    !busy &&
    positive.trim().length > 0 &&
    ckptName.length > 0 &&
    (mode === "txt2img" || !!uploaded);

  const progressPct =
    progress && progress.max > 0
      ? Math.min(100, Math.round((progress.value / progress.max) * 100))
      : 0;

  const stageText =
    status === "uploading"
      ? "上传参考图…"
      : status === "queued"
        ? "排队中…"
        : status === "sampling"
          ? progress
            ? `采样中 ${progress.value}/${progress.max}`
            : "采样中…"
          : "";

  const activeResult = results[activeIdx];

  return (
    <div className="create-view">
      {/* ───── 左:画布区 ───── */}
      <section className="cv-canvas">
        <header className="cv-canvas-top">
          <div className="cv-mode-tabs" role="tablist" aria-label="生成模式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "txt2img"}
              className={`cv-mode-tab${mode === "txt2img" ? " is-active" : ""}`}
              onClick={() => switchMode("txt2img")}
            >
              <Icon name="create" size={14} />
              文生图
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "img2img"}
              className={`cv-mode-tab${mode === "img2img" ? " is-active" : ""}`}
              onClick={() => switchMode("img2img")}
            >
              <Icon name="image" size={14} />
              图生图
            </button>
          </div>
          <div className="cv-canvas-meta">
            {activePreset && presets.find(p => p.id === activePreset) && (
              <span className="badge badge-preset" title="当前风格预设">
                <Icon name="sparkles" size={11} /> {presets.find(p => p.id === activePreset)?.label}
              </span>
            )}
            {ckptName && (
              <span className="badge badge-accent" title={ckptName}>
                {modelLabel(ckptName)}
              </span>
            )}
            <span className="badge">{width}×{height}</span>
            {lastSeed != null && (
              <span className="badge" title="上次实际种子">seed {lastSeed}</span>
            )}
          </div>
        </header>

        <div className="cv-stage">
          {/* 空态 */}
          {!busy && results.length === 0 && status !== "error" && (
            <div className="empty-state cv-empty">
              <div className="empty-state-icon">
                <Icon name="create" size={56} strokeWidth={1.1} />
              </div>
              <div className="empty-state-title">输入提示词开始创作</div>
              <div className="empty-state-desc">
                {mode === "txt2img"
                  ? "在右侧填写正向提示词,点击生成"
                  : "在右侧上传参考图并填写提示词"}
              </div>
            </div>
          )}

          {/* 生成中 */}
          {busy && (
            <div className="cv-loading">
              <div className="cv-loading-card">
                <div className="cv-loading-orb" aria-hidden="true" />
                <div className="cv-loading-stage">{stageText || "生成中…"}</div>
                <div className="cv-progress">
                  <div
                    className="cv-progress-bar"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="cv-progress-pct">
                  {status === "sampling" && progress ? `${progressPct}%` : "—"}
                </div>
              </div>
            </div>
          )}

          {/* 结果展示 */}
          {!busy && results.length > 0 && activeResult && (
            <div className="cv-result">
              <div className="cv-result-frame">
                <img src={activeResult.url} alt={positive} />
              </div>

              {results.length > 1 && (
                <>
                  <button
                    type="button"
                    className="cv-carousel-nav cv-carousel-prev"
                    onClick={() =>
                      setActiveIdx((i) => (i - 1 + results.length) % results.length)
                    }
                    aria-label="上一张"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className="cv-carousel-nav cv-carousel-next"
                    onClick={() => setActiveIdx((i) => (i + 1) % results.length)}
                    aria-label="下一张"
                  >
                    ›
                  </button>
                  <div className="cv-carousel-dots">
                    {results.map((r, i) => (
                      <button
                        key={r.path}
                        type="button"
                        className={`cv-dot${i === activeIdx ? " is-active" : ""}`}
                        onClick={() => setActiveIdx(i)}
                        aria-label={`第 ${i + 1} 张`}
                      />
                    ))}
                  </div>
                  <div className="cv-carousel-count">
                    {activeIdx + 1} / {results.length}
                  </div>
                </>
              )}
            </div>
          )}

          {/* 错误态 */}
          {!busy && status === "error" && error && (
            <div className="empty-state cv-error-state">
              <div className="empty-state-icon" style={{ color: "var(--danger)" }}>
                <Icon name="error" size={48} strokeWidth={1.4} />
              </div>
              <div className="empty-state-title">生成失败</div>
              <div className="empty-state-desc">{error}</div>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: "0.75rem" }}
                onClick={() => gen.reset()}
              >
                重试
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ───── 右:参数面板 ───── */}
      <aside className="cv-panel">
        <div className="cv-panel-scroll">
          {/* 提示词 */}
          <div className="card cv-section">
            <div className="cv-section-head">
              <label className="cv-label" htmlFor="cv-positive">正向提示词</label>
              <OptimizeButton
                prompt={positive}
                kind={mode === "img2img" ? "image_edit" : "image"}
                model={ckptName}
                onOptimized={(text, negative) => {
                  setPositive(text);
                  if (negative) {
                    setNegative(negative);
                    setNegOpen(true);
                  }
                }}
              />
            </div>
            <textarea
              id="cv-positive"
              className="input cv-textarea"
              placeholder="描述你想要生成的画面…"
              rows={4}
              value={positive}
              onChange={(e) => setPositive(e.target.value)}
            />
          </div>

          {/* 负向提示词(可折叠) */}
          <div className="card cv-section">
            <button
              type="button"
              className="cv-collapse-head"
              onClick={() => setNegOpen((v) => !v)}
              aria-expanded={negOpen}
            >
              <span className="cv-label">负向提示词</span>
              <span className={`cv-chevron${negOpen ? " is-open" : ""}`}>‹</span>
            </button>
            {negOpen && (
              <textarea
                className="input cv-textarea"
                placeholder="不想出现的元素,如 lowres, blurry…"
                rows={3}
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
                style={{ marginTop: "0.5rem" }}
              />
            )}
          </div>

          {/* 风格预设 */}
          <div className="card cv-section">
            <div className="cv-section-head">
              <span className="cv-label" style={{ display: "inline-flex", alignItems: "center" }}>
                <Icon name="sparkles" size={11} />
                <span style={{ marginLeft: 4 }}>风格预设</span>
              </span>
              {activePreset && (
                <button type="button" className="cv-preset-clear" onClick={clearStylePreset}>
                  <Icon name="close" size={11} /> 清除
                </button>
              )}
            </div>
            {presetsLoading ? (
              <div className="cv-field-loading"><Icon name="loading" size={13} /> 加载预设…</div>
            ) : presets.length === 0 ? (
              <div className="cv-field-error">暂无可用预设</div>
            ) : (
              <div className="cv-preset-grid">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`cv-preset-chip${activePreset === p.id ? " is-active" : ""}`}
                    onClick={() => applyStylePreset(p)}
                    title={p.description}
                  >
                    <span className="cv-preset-label">{p.label}</span>
                    {p.commercial_safe && <span className="cv-preset-badge" title="可商用">©</span>}
                  </button>
                ))}
              </div>
            )}
            {activePreset && (() => {
              const p = presets.find((x) => x.id === activePreset);
              if (!p) return null;
              return (
                <div className="cv-preset-desc">
                  <Icon name="info" size={11} /> {p.description} · {p.llm_layer}润色
                </div>
              );
            })()}
          </div>

          {/* 图生图上传区 */}
          {mode === "img2img" && (
            <div className="card cv-section">
              <div className="cv-label">参考图</div>
              <div
                className={`cv-upload${dragOver ? " is-drag" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="上传图片,按 Enter 或空格激活"
              >
                {uploaded ? (
                  <div className="cv-upload-preview">
                    <img src={uploaded.previewUrl} alt={uploaded.name} />
                    <div className="cv-upload-meta">
                      <span className="cv-upload-name">{uploaded.name}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm cv-upload-clear"
                        onClick={(e) => {
                          e.stopPropagation();
                          setUploaded(null);
                        }}
                      >
                        <Icon name="close" size={12} /> 清除
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="cv-upload-empty">
                    <Icon name="upload" size={22} strokeWidth={1.5} />
                    <div>点击或拖拽图片到此处</div>
                    <div className="cv-upload-hint">支持 PNG / JPG / WebP</div>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => void handleFileChange(e.target.files?.[0])}
                />
              </div>

              <div className="cv-slider-row">
                <label className="cv-slider-label">
                  重绘幅度
                  <span className="cv-slider-val">{denoise.toFixed(2)}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={denoise}
                  onChange={(e) => setDenoise(Number(e.target.value))}
                  className="cv-range"
                />
              </div>
            </div>
          )}

          {/* 尺寸 */}
          <div className="card cv-section">
            <div className="cv-label">输出尺寸</div>
            <div className="cv-size-grid">
              {SIZE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`cv-size-btn${!sizeCustom && width === p.w && height === p.h ? " is-active" : ""}`}
                  onClick={() => applyPreset(p.w, p.h)}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                className={`cv-size-btn${sizeCustom ? " is-active" : ""}`}
                onClick={() => setSizeCustom(true)}
              >
                自定义
              </button>
            </div>
            {sizeCustom && (
              <div className="cv-size-custom">
                <label className="cv-mini-input">
                  <span>宽</span>
                  <input
                    type="number"
                    min={64}
                    max={2048}
                    step={64}
                    value={width}
                    onChange={(e) => setWidth(Math.max(64, Math.min(2048, Number(e.target.value) || 512)))}
                  />
                </label>
                <label className="cv-mini-input">
                  <span>高</span>
                  <input
                    type="number"
                    min={64}
                    max={2048}
                    step={64}
                    value={height}
                    onChange={(e) => setHeight(Math.max(64, Math.min(2048, Number(e.target.value) || 512)))}
                  />
                </label>
              </div>
            )}
          </div>

          {/* 底模 */}
          <div className="card cv-section">
            <label className="cv-label" htmlFor="cv-ckpt">底模</label>
            {modelsLoading ? (
              <div className="loading-spinner cv-field-loading">
                <Icon name="loading" size={14} /> 加载中…
              </div>
            ) : modelsError ? (
              <div className="cv-field-error">
                <Icon name="error" size={13} /> {modelsError}
              </div>
            ) : (
              <>
                <select
                  id="cv-ckpt"
                  className="input cv-select"
                  value={ckptName}
                  onChange={(e) => { setCkptName(e.target.value); manualChange(); }}
                >
                  {ckptOptions.length === 0 && <option value="">无可用模型</option>}
                  {ckptOptions.map((c) => {
                    const tag = modelTag(c);
                    const label = modelLabel(c);
                    return (
                      <option key={c} value={c}>
                        {tag ? `[${tag}] ${label}` : label}
                      </option>
                    );
                  })}
                </select>
                {isNextgenCkpt(ckptName) && (
                  <div className="cv-model-hint">
                    <Icon name="zap" size={11} /> 次世代模型,CFG固定≈1.0,自动选择采样器
                  </div>
                )}
              </>
            )}
          </div>

          {/* 采样器 / 调度器 */}
          <div className="card cv-section">
            <div className="cv-field-pair">
              <div>
                <label className="cv-label" htmlFor="cv-sampler">采样器</label>
                <select
                  id="cv-sampler"
                  className="input cv-select"
                  value={sampler}
                  onChange={(e) => setSampler(e.target.value)}
                >
                  {samplerOptions.length === 0 && <option value="euler">euler</option>}
                  {samplerOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="cv-label" htmlFor="cv-scheduler">调度器</label>
                <select
                  id="cv-scheduler"
                  className="input cv-select"
                  value={scheduler}
                  onChange={(e) => setScheduler(e.target.value)}
                >
                  {schedulerOptions.length === 0 && <option value="normal">normal</option>}
                  {schedulerOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* 步数 / CFG */}
          <div className="card cv-section">
            <div className="cv-slider-row">
              <label className="cv-slider-label" htmlFor="cv-steps">
                采样步数
                <span className="cv-slider-val">{steps}</span>
              </label>
              <input
                id="cv-steps"
                type="range"
                min={10}
                max={50}
                step={1}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                className="cv-range"
              />
            </div>
            <div className="cv-slider-row">
              <label className="cv-slider-label" htmlFor="cv-cfg">
                CFG
                <span className="cv-slider-val">{cfg.toFixed(1)}</span>
              </label>
              <input
                id="cv-cfg"
                type="range"
                min={1}
                max={15}
                step={0.5}
                value={cfg}
                onChange={(e) => setCfg(Number(e.target.value))}
                className="cv-range"
              />
            </div>
          </div>

          {/* 种子 */}
          <div className="card cv-section">
            <div className="cv-seed-head">
              <label className="cv-label" htmlFor="cv-seed">种子</label>
              <label className="cv-lock-toggle">
                <input
                  type="checkbox"
                  checked={seedLocked}
                  onChange={(e) => setSeedLocked(e.target.checked)}
                />
                <span>固定</span>
              </label>
            </div>
            <div className="cv-seed-row">
              <input
                id="cv-seed"
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
                className="btn btn-ghost btn-sm cv-locklast"
                onClick={lockLastSeed}
              >
                锁定上次种子({lastSeed})
              </button>
            )}
          </div>

          {/* 批量(仅文生图) */}
          {mode === "txt2img" && (
            <div className="card cv-section">
              <div className="cv-label">批量数量</div>
              <div className="cv-batch-grid">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`cv-size-btn${batchSize === n ? " is-active" : ""}`}
                    onClick={() => setBatchSize(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 生成按钮(固定底部) */}
        <div className="cv-panel-foot">
          <button
            type="button"
            className="btn btn-primary cv-generate-btn"
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
                <Icon name="create" size={16} />
                生成{mode === "txt2img" ? (batchSize > 1 ? ` ×${batchSize}` : "") : ""}
              </>
            )}
          </button>
          {error && !busy && (
            <div className="cv-foot-error">
              <Icon name="error" size={12} /> {error}
            </div>
          )}
        </div>
      </aside>

      <style jsx>{`
        .create-view {
          display: grid;
          grid-template-columns: 1fr var(--param-w);
          height: 100%;
          min-height: calc(100vh - var(--topbar-h));
          background: var(--bg-0);
        }

        /* ───── 左:画布 ───── */
        .cv-canvas {
          display: flex;
          flex-direction: column;
          min-width: 0;
          border-right: 1px solid var(--hairline);
          background:
            radial-gradient(
              120% 80% at 50% 0%,
              oklch(55% 0.20 265 / 0.05),
              transparent 60%
            ),
            var(--bg-0);
        }
        .cv-canvas-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--hairline);
          flex-shrink: 0;
        }
        .cv-mode-tabs {
          display: inline-flex;
          gap: 2px;
          padding: 3px;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
        }
        .cv-mode-tab {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.35rem 0.75rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-xs);
          color: var(--ink-soft);
          font-size: 0.82rem;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: background-color var(--dur) var(--ease),
            color var(--dur) var(--ease), border-color var(--dur) var(--ease);
        }
        .cv-mode-tab:hover {
          color: var(--ink);
          background: var(--bg-2);
        }
        .cv-mode-tab.is-active {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .cv-canvas-meta {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          min-width: 0;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .cv-canvas-meta .badge {
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* 画布舞台 */
        .cv-stage {
          position: relative;
          flex: 1;
          min-height: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-5);
        }
        .cv-empty {
          width: 100%;
          max-width: 480px;
        }

        /* 加载态 */
        .cv-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
        }
        .cv-loading-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.9rem;
          padding: var(--space-5);
        }
        .cv-loading-orb {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: radial-gradient(
            circle at 35% 35%,
            var(--accent-hover),
            var(--accent-deep) 60%,
            transparent 70%
          );
          filter: blur(6px);
          opacity: 0.85;
          animation: cv-orb-pulse 2s ease-in-out infinite;
        }
        @keyframes cv-orb-pulse {
          0%, 100% { transform: scale(1); opacity: 0.7; }
          50% { transform: scale(1.18); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .cv-loading-orb { animation: none; }
        }
        .cv-loading-stage {
          font-size: 0.9rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }
        .cv-progress {
          width: 280px;
          height: 4px;
          background: var(--bg-2);
          border-radius: var(--radius-full);
          overflow: hidden;
        }
        .cv-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, var(--accent-deep), var(--accent-soft));
          border-radius: var(--radius-full);
          transition: width 0.2s var(--ease);
        }
        .cv-progress-pct {
          font-size: 0.78rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }

        /* 结果展示 */
        .cv-result {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
        }
        .cv-result-frame {
          max-width: 100%;
          max-height: 100%;
          border-radius: var(--radius-lg);
          overflow: hidden;
          border: 1px solid var(--hairline-2);
          box-shadow: var(--shadow-lg),
            0 0 60px -20px oklch(55% 0.20 265 / 0.35);
          background: var(--bg-1);
        }
        .cv-result-frame img {
          display: block;
          max-width: 100%;
          max-height: calc(100vh - var(--topbar-h) - 140px);
          object-fit: contain;
        }
        .cv-carousel-nav {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 36px;
          height: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: oklch(7% 0.006 265 / 0.7);
          backdrop-filter: blur(6px);
          border: 1px solid var(--hairline-2);
          border-radius: 50%;
          color: var(--ink);
          font-size: 1.4rem;
          line-height: 1;
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease);
        }
        .cv-carousel-nav:hover {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .cv-carousel-prev { left: 8px; }
        .cv-carousel-next { right: 8px; }
        .cv-carousel-dots {
          position: absolute;
          bottom: 12px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          gap: 6px;
        }
        .cv-dot {
          width: 7px;
          height: 7px;
          padding: 0;
          border-radius: 50%;
          background: oklch(80% 0.005 265 / 0.4);
          border: none;
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            transform var(--dur) var(--ease);
        }
        .cv-dot.is-active {
          background: var(--accent);
          transform: scale(1.3);
        }
        .cv-carousel-count {
          position: absolute;
          top: 12px;
          right: 12px;
          padding: 0.2rem 0.55rem;
          background: oklch(7% 0.006 265 / 0.7);
          backdrop-filter: blur(6px);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-full);
          font-size: 0.72rem;
          font-family: var(--font-mono);
          color: var(--ink-soft);
        }

        .cv-error-state { max-width: 420px; }

        /* ───── 右:参数面板 ───── */
        .cv-panel {
          display: flex;
          flex-direction: column;
          background: var(--bg-1);
          min-height: 0;
        }
        .cv-panel-scroll {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-3);
        }
        .cv-panel-scroll::-webkit-scrollbar { width: 8px; }
        .cv-panel-scroll::-webkit-scrollbar-track { background: transparent; }
        .cv-panel-scroll::-webkit-scrollbar-thumb {
          background: var(--hairline-2);
          border-radius: 4px;
        }
        .cv-panel-scroll::-webkit-scrollbar-thumb:hover {
          background: var(--hairline-strong);
        }

        .cv-section {
          padding: var(--space-3);
        }
        .cv-section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        .cv-label {
          display: block;
          font-size: 0.76rem;
          font-weight: 500;
          color: var(--ink-soft);
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }
        .cv-optimize-btn {
          font-size: 0.74rem;
          padding: 0.2rem 0.55rem;
          color: var(--accent-soft);
        }
        .cv-textarea {
          min-height: 90px;
          font-size: 0.85rem;
          line-height: 1.5;
        }

        /* 折叠头 */
        .cv-collapse-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 0;
          background: transparent;
          border: none;
          cursor: pointer;
          color: inherit;
        }
        .cv-chevron {
          color: var(--ink-faint);
          font-size: 0.9rem;
          transform: rotate(-90deg);
          transition: transform var(--dur) var(--ease);
        }
        .cv-chevron.is-open {
          transform: rotate(90deg);
        }

        /* 上传区 */
        .cv-upload {
          margin-top: 0.5rem;
          border: 1px dashed var(--hairline-strong);
          border-radius: var(--radius);
          background: var(--bg-2);
          cursor: pointer;
          transition: border-color var(--dur) var(--ease),
            background-color var(--dur) var(--ease);
          overflow: hidden;
        }
        .cv-upload:hover,
        .cv-upload.is-drag {
          border-color: var(--accent);
          background: var(--accent-wash);
        }
        .cv-upload-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          padding: var(--space-4);
          color: var(--ink-faint);
          font-size: 0.82rem;
          text-align: center;
        }
        .cv-upload-hint {
          font-size: 0.72rem;
          color: var(--ink-faint);
          opacity: 0.7;
        }
        .cv-upload-preview {
          display: flex;
          gap: 0.6rem;
          padding: 0.5rem;
          align-items: center;
        }
        .cv-upload-preview img {
          width: 64px;
          height: 64px;
          object-fit: cover;
          border-radius: var(--radius-xs);
          border: 1px solid var(--hairline);
        }
        .cv-upload-meta {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          min-width: 0;
          flex: 1;
        }
        .cv-upload-name {
          font-size: 0.78rem;
          color: var(--ink-soft);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cv-upload-clear {
          align-self: flex-start;
          color: var(--danger);
        }

        /* 滑块行 */
        .cv-slider-row {
          margin-top: 0.6rem;
        }
        .cv-slider-row:first-child {
          margin-top: 0;
        }
        .cv-slider-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 0.76rem;
          color: var(--ink-soft);
          margin-bottom: 0.35rem;
        }
        .cv-slider-val {
          font-family: var(--font-mono);
          color: var(--accent-soft);
          font-size: 0.78rem;
        }
        .cv-range {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 4px;
          background: var(--bg-3);
          border-radius: var(--radius-full);
          outline: none;
          cursor: pointer;
        }
        .cv-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--bg-1);
          box-shadow: 0 0 0 1px var(--accent-line);
          cursor: pointer;
          transition: transform var(--dur) var(--ease);
        }
        .cv-range::-webkit-slider-thumb:hover {
          transform: scale(1.15);
        }
        .cv-range::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--bg-1);
          box-shadow: 0 0 0 1px var(--accent-line);
          cursor: pointer;
        }

        /* 尺寸网格 */
        .cv-size-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.4rem;
          margin-top: 0.5rem;
        }
        .cv-size-btn {
          padding: 0.4rem 0;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          color: var(--ink-soft);
          font-size: 0.76rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease), color var(--dur) var(--ease);
        }
        .cv-size-btn:hover {
          background: var(--bg-3);
          color: var(--ink);
        }
        .cv-size-btn.is-active {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .cv-size-custom {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.5rem;
          margin-top: 0.6rem;
        }
        .cv-mini-input {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          font-size: 0.72rem;
          color: var(--ink-faint);
        }
        .cv-mini-input input {
          width: 100%;
          padding: 0.35rem 0.5rem;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          color: var(--ink);
          font-size: 0.82rem;
          font-family: var(--font-mono);
        }
        .cv-mini-input input:focus {
          outline: none;
          border-color: var(--accent);
        }

        /* 选择器 */
        .cv-select {
          appearance: none;
          -webkit-appearance: none;
          padding-right: 2rem;
          /* 用 CSS 渐变绘制可着色的下拉箭头(与 admin-select 一致,引用 --ink-faint) */
          background-image: linear-gradient(45deg, transparent 50%, var(--ink-faint) 50%),
            linear-gradient(135deg, var(--ink-faint) 50%, transparent 50%);
          background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
          background-size: 5px 5px, 5px 5px;
          background-repeat: no-repeat;
          cursor: pointer;
        }
        .cv-field-pair {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.6rem;
        }
        .cv-field-loading,
        .cv-field-error {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.78rem;
          padding: 0.35rem 0;
        }
        .cv-field-error {
          color: var(--danger);
        }

        /* 种子 */
        .cv-seed-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.5rem;
        }
        .cv-lock-toggle {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.76rem;
          color: var(--ink-soft);
          cursor: pointer;
        }
        .cv-seed-row {
          display: flex;
          gap: 0.4rem;
        }
        .cv-locklast {
          margin-top: 0.5rem;
          width: 100%;
          color: var(--accent-soft);
        }

        /* 批量 */
        .cv-batch-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.4rem;
          margin-top: 0.5rem;
        }

        /* 底部生成按钮 */
        .cv-panel-foot {
          flex-shrink: 0;
          padding: var(--space-3);
          border-top: 1px solid var(--hairline);
          background: var(--bg-1);
        }
        .cv-generate-btn {
          width: 100%;
          padding: 0.7rem 1rem;
          font-size: 0.92rem;
          font-weight: 600;
          border-radius: var(--radius-sm);
          box-shadow: 0 4px 18px -6px oklch(55% 0.20 265 / 0.5);
        }
        .cv-generate-btn:not(:disabled):hover {
          box-shadow: 0 6px 24px -6px oklch(55% 0.20 265 / 0.65);
        }
        .cv-foot-error {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          margin-top: 0.5rem;
          font-size: 0.74rem;
          color: var(--danger);
        }

        /* 风格预设 */
        .cv-preset-clear {
          display: inline-flex;
          align-items: center;
          gap: 0.2rem;
          padding: 0.15rem 0.45rem;
          background: transparent;
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          color: var(--ink-faint);
          font-size: 0.68rem;
          cursor: pointer;
          transition: all var(--dur) var(--ease);
        }
        .cv-preset-clear:hover {
          color: var(--danger);
          border-color: var(--danger);
        }
        .cv-preset-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 0.35rem;
          margin-top: 0.55rem;
        }
        .cv-preset-chip {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.32rem 0.6rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink-soft);
          font-size: 0.74rem;
          font-weight: 500;
          cursor: pointer;
          transition: all var(--dur) var(--ease);
          white-space: nowrap;
        }
        .cv-preset-chip:hover {
          background: var(--bg-3);
          border-color: var(--accent-line);
          color: var(--ink);
        }
        .cv-preset-chip.is-active {
          background: var(--accent-quiet);
          border-color: var(--accent);
          color: var(--accent-soft);
          box-shadow: 0 0 0 1px var(--accent-line);
        }
        .cv-preset-badge {
          font-size: 0.6rem;
          opacity: 0.7;
          margin-left: 0.1rem;
        }
        .cv-preset-desc {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          margin-top: 0.5rem;
          padding: 0.35rem 0.5rem;
          background: var(--accent-wash, oklch(55% 0.20 265 / 0.06));
          border-radius: var(--radius-xs);
          font-size: 0.68rem;
          color: var(--accent-soft);
          line-height: 1.4;
        }

        /* 底模提示 */
        .cv-model-hint {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          margin-top: 0.4rem;
          font-size: 0.68rem;
          color: var(--accent-soft);
          opacity: 0.8;
        }

        /* 预设徽章 */
        .badge-preset {
          background: oklch(55% 0.20 265 / 0.15);
          color: var(--accent-soft);
          border-color: oklch(55% 0.20 265 / 0.3);
        }
        .badge-preset svg { display: inline; }

        /* 移动端:堆叠 */
        @media (max-width: 880px) {
          .create-view {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(360px, 60vh) auto;
          }
          .cv-canvas {
            border-right: none;
            border-bottom: 1px solid var(--hairline);
          }
          .cv-result-frame img {
            max-height: calc(60vh - 140px);
          }
        }
      `}</style>
    </div>
  );
}
