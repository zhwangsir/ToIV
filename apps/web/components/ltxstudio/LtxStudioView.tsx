"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";

import { imageUrl, uploadImage } from "@/lib/api";
import {
  fetchLtx2Job,
  generateLtx2I2V,
  generateLtx2T2V,
  getLtx2Models,
  type Ltx2T2VParams,
  type Ltx2ModelsResponse,
} from "@/lib/ltxstudio";
import { usePoll } from "@/hooks/usePoll";
import { Icon } from "@/components/ui/Icon";

type Tab = "t2v" | "i2v";
type JobState = "idle" | "running" | "done" | "error";

interface UploadedRef {
  filename: string;
  worker: string;
  previewUrl: string;
  name: string;
}

// 半分辨率预设:2 阶段采样后上采样到目标清晰度(与 NSFW 视频页同一约定)
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

const MAX_LORAS = 3;
const POLL_INTERVAL_MS = 3000;
// 上传校验:后端 /api/upload 上限 20MB;扩展名白名单与动态分镜页一致
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

const TABS: { id: Tab; label: string; icon: "create" | "image" }[] = [
  { id: "t2v", label: "文生视频", icon: "create" },
  { id: "i2v", label: "图生视频", icon: "image" },
];

/**
 * LTX-2.3 工作室视图。
 * - 文生视频 / 图生视频两 Tab;底模白名单下拉 + loras/ltx2.3/ LoRA 叠加(≤3,强度 0-2)
 * - 提交后轮询 GET /api/jobs 按 prompt_id 跟踪状态,done 后 <video> 播放
 * - 错误一律进页面内错误条,不静默
 */
export function LtxStudioView() {
  const [tab, setTab] = useState<Tab>("t2v");

  // 资产清单(白名单底模 + LoRA)
  const [models, setModels] = useState<Ltx2ModelsResponse | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [unetName, setUnetName] = useState("ltx-2.3-distilled.safetensors");
  // LoRA 选择:name → strength(0-2,默认 1.0)
  const [loraSel, setLoraSel] = useState<Record<string, number>>({});

  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  const [negOpen, setNegOpen] = useState(false);

  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(384);
  const [length, setLength] = useState(97);
  const [fps, setFps] = useState(16);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(1.0);
  const [seedInput, setSeedInput] = useState("");
  const [useUpscale, setUseUpscale] = useState(false);
  const [useRife, setUseRife] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [imageUploaded, setImageUploaded] = useState<UploadedRef | null>(null);
  const [uploading, setUploading] = useState(false);
  const [imageDragOver, setImageDragOver] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // 作业跟踪:submitting = POST 阶段;activePromptId 非空 = 轮询中
  const [submitting, setSubmitting] = useState(false);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const [jobState, setJobState] = useState<JobState>("idle");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 加载资产清单
  useEffect(() => {
    let cancelled = false;
    getLtx2Models()
      .then((m) => {
        if (cancelled) return;
        setModels(m);
        // 当前选中不可用时自动切到第一个可用底模
        const firstAvail = m.unets.find((u) => u.available);
        if (firstAvail) {
          setUnetName((cur) => {
            const curInfo = m.unets.find((u) => u.name === cur);
            return curInfo?.available ? cur : firstAvail.name;
          });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setModelsError(e instanceof Error ? e.message : "加载模型清单失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 轮询作业状态:done → 播视频;error → 错误条。瞬断不致命,usePoll backoff 容错。
  usePoll(
    async () => {
      if (!activePromptId) return;
      const job = await fetchLtx2Job(activePromptId);
      if (!job) return; // 尚未入库/列表未刷新,下轮再试
      if (job.status === "done") {
        setActivePromptId(null);
        const first = job.results[0];
        if (first) {
          setResultUrl(imageUrl(first));
          setJobState("done");
        } else {
          setError("生成完成但未返回视频");
          setJobState("error");
        }
      } else if (job.status === "error") {
        setActivePromptId(null);
        setError("生成失败,请调整参数后重试");
        setJobState("error");
      }
    },
    {
      intervalMs: POLL_INTERVAL_MS,
      enabled: activePromptId !== null,
      backoff: true,
    },
  );

  // LoRA 勾选/强度
  const toggleLora = useCallback((name: string) => {
    setLoraSel((prev) => {
      if (name in prev) {
        const next = { ...prev };
        delete next[name];
        return next;
      }
      if (Object.keys(prev).length >= MAX_LORAS) return prev;
      return { ...prev, [name]: 1.0 };
    });
  }, []);
  const setLoraStrength = useCallback((name: string, strength: number) => {
    setLoraSel((prev) => (name in prev ? { ...prev, [name]: strength } : prev));
  }, []);

  // 图片上传(i2v):路由到具备 LTX 模型/节点的 worker
  const handleImageUpload = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || !IMAGE_EXT_OK.includes(fileExt(file.name))) {
      setError(`「${file.name}」格式不支持(仅 jpg/png/webp)`);
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError(`「${file.name}」超过 20MB 上限(${(file.size / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const r = await uploadImage(file, "ltx_i2v");
      setImageUploaded({
        filename: r.filename,
        worker: r.worker,
        previewUrl: imageUrl(r.filename),
        name: file.name,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  }, []);

  const handleImageDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      setImageDragOver(false);
      void handleImageUpload(e.dataTransfer.files?.[0]);
    },
    [handleImageUpload],
  );

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    setError(null);
  }, []);

  const busy = submitting || uploading || activePromptId !== null;
  const canGenerate =
    !busy && positive.trim().length > 0 && (tab === "t2v" || !!imageUploaded);

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    setError(null);
    setResultUrl(null);
    setSubmitting(true);
    try {
      const loras = Object.entries(loraSel)
        .slice(0, MAX_LORAS)
        .map(([name, strength]) => ({ name, strength }));
      const seedNum = seedInput.trim() ? Number(seedInput) : null;
      const params: Ltx2T2VParams = {
        positive: positive.trim(),
        negative: negative.trim() || undefined,
        unet_name: unetName,
        loras: loras.length > 0 ? loras : undefined,
        width,
        height,
        length,
        fps,
        steps,
        cfg,
        seed: seedNum !== null && Number.isFinite(seedNum) ? seedNum : null,
        use_upscale: useUpscale,
        use_rife: useRife,
      };
      const res =
        tab === "t2v"
          ? await generateLtx2T2V(params)
          : await generateLtx2I2V({
              ...params,
              image: imageUploaded?.filename ?? "",
              worker: imageUploaded?.worker ?? "",
            });
      setJobState("running");
      setActivePromptId(res.prompt_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成请求失败");
      setJobState("error");
    } finally {
      setSubmitting(false);
    }
  }, [
    canGenerate, loraSel, seedInput, positive, negative, unetName,
    width, height, length, fps, steps, cfg, useUpscale, useRife,
    tab, imageUploaded,
  ]);

  const selectedUnet = models?.unets.find((u) => u.name === unetName);
  const loras = models?.loras ?? [];
  const secondsLabel = Math.round(length / Math.max(1, fps));

  return (
    <div className="lxs-view">
      {/* ───── 左:视频画布 ───── */}
      <section className="lxs-canvas">
        <header className="lxs-canvas-top">
          <div className="lxs-tabs" role="tablist" aria-label="生成方式">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`lxs-tab${tab === t.id ? " is-active" : ""}`}
                onClick={() => switchTab(t.id)}
              >
                <Icon name={t.icon} size={14} />
                {t.label}
              </button>
            ))}
          </div>
          <div className="lxs-canvas-meta">
            <span className="badge badge-accent" title="LTX-2.3 工作室">
              LTX-2.3
            </span>
            <span className="badge" title="半分辨率">
              {width}×{height}
            </span>
            <span className="badge" title="时长 / 帧率">
              {secondsLabel}s · {fps}fps
            </span>
          </div>
        </header>

        <div className="lxs-stage">
          {/* 空态 */}
          {!busy && !resultUrl && jobState !== "error" && (
            <div className="empty-state lxs-empty">
              <div className="empty-state-icon">
                <Icon name="film" size={56} strokeWidth={1.1} />
              </div>
              <div className="empty-state-title">LTX-2.3 工作室</div>
              <div className="empty-state-desc">
                {tab === "t2v"
                  ? "选择底模与 LoRA,填写提示词开始生成"
                  : "上传首帧参考图并填写提示词,生成动态视频"}
              </div>
            </div>
          )}

          {/* 生成中 */}
          {busy && (
            <div className="lxs-loading">
              <div className="lxs-loading-card">
                <div className="lxs-loading-orb" aria-hidden="true" />
                <div className="lxs-loading-stage">
                  {uploading ? "上传参考图中…" : submitting ? "提交任务中…" : "生成中,通常需要数分钟…"}
                </div>
              </div>
            </div>
          )}

          {/* 结果 */}
          {!busy && resultUrl && (
            <div className="lxs-result">
              <video
                src={resultUrl}
                controls
                autoPlay
                loop
                playsInline
                className="lxs-video"
              />
            </div>
          )}

          {/* 错误态 */}
          {!busy && jobState === "error" && error && (
            <div className="empty-state lxs-error-state">
              <div className="empty-state-icon" style={{ color: "var(--danger)" }}>
                <Icon name="error" size={48} strokeWidth={1.4} />
              </div>
              <div className="empty-state-title">生成失败</div>
              <div className="empty-state-desc">{error}</div>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: "0.75rem" }}
                onClick={() => setJobState("idle")}
              >
                重试
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ───── 右:参数面板 ───── */}
      <aside className="lxs-panel">
        <div className="lxs-panel-scroll">
          {/* 底模 */}
          <div className="card lxs-section">
            <label className="lxs-label" htmlFor="lxs-unet">底模</label>
            <select
              id="lxs-unet"
              className="input lxs-select"
              value={unetName}
              onChange={(e) => setUnetName(e.target.value)}
              disabled={busy}
            >
              {(models?.unets ?? [{ name: unetName, nsfw: false, available: true }]).map((u) => (
                <option key={u.name} value={u.name} disabled={!u.available}>
                  {u.name}
                  {u.nsfw ? "(NSFW)" : ""}
                  {u.available ? "" : " — 未部署"}
                </option>
              ))}
            </select>
            {modelsError && (
              <div className="lxs-field-hint">
                <Icon name="warning" size={11} /> {modelsError}
              </div>
            )}
            {selectedUnet?.nsfw && (
              <div className="lxs-field-hint">
                <Icon name="lock" size={11} /> NSFW 底模,仅限 /nsfw 专区调用(主站提交会被拒绝)
              </div>
            )}
          </div>

          {/* LoRA 叠加 */}
          <div className="card lxs-section">
            <div className="lxs-label">
              LoRA 叠加({Object.keys(loraSel).length}/{MAX_LORAS})
            </div>
            {loras.length === 0 ? (
              <div className="lxs-field-hint">
                {modelsError ? "清单不可用" : "worker 上暂无 loras/ltx2.3/ 目录 LoRA"}
              </div>
            ) : (
              <div className="lxs-lora-list">
                {loras.map((l) => {
                  const checked = l.name in loraSel;
                  const disabled = !checked && Object.keys(loraSel).length >= MAX_LORAS;
                  return (
                    <div
                      key={l.name}
                      className={`lxs-lora-card${checked ? " is-active" : ""}${disabled ? " is-disabled" : ""}`}
                    >
                      <label className="lxs-lora-head">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled || busy}
                          onChange={() => toggleLora(l.name)}
                        />
                        <span className="lxs-lora-name" title={l.name}>
                          {l.name.replace(/^ltx2\.3\//, "").replace(/\.safetensors$/, "")}
                        </span>
                      </label>
                      {checked && (
                        <div className="lxs-lora-strength">
                          <input
                            type="range"
                            min={0}
                            max={2}
                            step={0.05}
                            value={loraSel[l.name]}
                            disabled={busy}
                            onChange={(e) => setLoraStrength(l.name, Number(e.target.value))}
                            aria-label={`${l.name} 强度`}
                          />
                          <span className="lxs-lora-val">{(loraSel[l.name] ?? 1).toFixed(2)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 提示词 */}
          <div className="card lxs-section">
            <label className="lxs-label" htmlFor="lxs-positive">正向提示词</label>
            <textarea
              id="lxs-positive"
              className="input lxs-textarea"
              placeholder="描述你想要生成的视频画面…"
              rows={4}
              value={positive}
              onChange={(e) => setPositive(e.target.value)}
            />
          </div>

          {/* 负向提示词(可折叠) */}
          <div className="card lxs-section">
            <button
              type="button"
              className="lxs-collapse-head"
              onClick={() => setNegOpen((v) => !v)}
              aria-expanded={negOpen}
            >
              <span className="lxs-label">负向提示词</span>
              <span className={`lxs-chevron${negOpen ? " is-open" : ""}`}>‹</span>
            </button>
            {negOpen && (
              <textarea
                className="input lxs-textarea"
                placeholder="不想出现的元素,如 lowres, blurry, watermark…"
                rows={3}
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
                style={{ marginTop: "0.5rem" }}
              />
            )}
          </div>

          {/* 参考图(仅 i2v) */}
          {tab === "i2v" && (
            <div className="card lxs-section">
              <div className="lxs-label">首帧参考图</div>
              <div
                className={`lxs-upload${imageDragOver ? " is-drag" : ""}`}
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
                aria-label="上传首帧参考图,按 Enter 或空格激活"
              >
                {imageUploaded ? (
                  <div className="lxs-upload-preview">
                    {/* eslint-disable-next-line @next/next/no-img-element -- 预览 worker 回传图 */}
                    <img src={imageUploaded.previewUrl} alt={imageUploaded.name} />
                    <div className="lxs-upload-meta">
                      <span className="lxs-upload-name">{imageUploaded.name}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm lxs-upload-clear"
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
                  <div className="lxs-upload-empty">
                    <Icon name="upload" size={22} strokeWidth={1.5} />
                    <div>点击或拖拽图片到此处</div>
                    <div className="lxs-upload-hint">支持 PNG / JPG / WebP</div>
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

          {/* 分辨率预设 */}
          <div className="card lxs-section">
            <div className="lxs-label">分辨率预设(半分辨率)</div>
            <div className="lxs-preset-grid">
              {RES_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`lxs-preset-btn${width === p.w && height === p.h ? " is-active" : ""}`}
                  onClick={() => {
                    setWidth(p.w);
                    setHeight(p.h);
                  }}
                >
                  <span className="lxs-preset-title">{p.label}</span>
                  <span className="lxs-preset-sub">{p.w}×{p.h}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 时长预设 */}
          <div className="card lxs-section">
            <div className="lxs-label">时长预设</div>
            <div className="lxs-preset-grid">
              {DURATION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`lxs-preset-btn${length === p.length ? " is-active" : ""}`}
                  onClick={() => setLength(p.length)}
                >
                  <span className="lxs-preset-title">{p.label}</span>
                  <span className="lxs-preset-sub">{p.length} 帧</span>
                </button>
              ))}
            </div>
          </div>

          {/* 高级参数(可折叠) */}
          <div className="card lxs-section">
            <button
              type="button"
              className="lxs-collapse-head"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              <span className="lxs-label">高级参数</span>
              <span className={`lxs-chevron${advancedOpen ? " is-open" : ""}`}>‹</span>
            </button>
            {advancedOpen && (
              <div className="lxs-advanced-body">
                <div className="lxs-num-grid">
                  <label className="lxs-num-field">
                    <span>帧率 fps</span>
                    <input
                      type="number"
                      className="input"
                      min={4}
                      max={30}
                      value={fps}
                      onChange={(e) => setFps(Number(e.target.value))}
                    />
                  </label>
                  <label className="lxs-num-field">
                    <span>步数</span>
                    <input
                      type="number"
                      className="input"
                      min={1}
                      max={50}
                      value={steps}
                      onChange={(e) => setSteps(Number(e.target.value))}
                    />
                  </label>
                  <label className="lxs-num-field">
                    <span>CFG</span>
                    <input
                      type="number"
                      className="input"
                      min={0}
                      max={20}
                      step={0.1}
                      value={cfg}
                      onChange={(e) => setCfg(Number(e.target.value))}
                    />
                  </label>
                </div>

                <label className="lxs-num-field lxs-seed-field">
                  <span>种子(留空随机)</span>
                  <input
                    type="number"
                    className="input"
                    placeholder="随机"
                    value={seedInput}
                    onChange={(e) => setSeedInput(e.target.value)}
                  />
                </label>

                <div className="lxs-toggle-row">
                  <div className="lxs-toggle-text">
                    <div className="lxs-toggle-title">2 阶段采样</div>
                    <div className="lxs-toggle-desc">半分辨率采样后上采样到目标清晰度</div>
                  </div>
                  <label className="lxs-switch">
                    <input
                      type="checkbox"
                      checked={useUpscale}
                      onChange={(e) => setUseUpscale(e.target.checked)}
                    />
                    <span className="lxs-switch-track" />
                  </label>
                </div>

                <div className="lxs-toggle-row">
                  <div className="lxs-toggle-text">
                    <div className="lxs-toggle-title">RIFE 插帧</div>
                    <div className="lxs-toggle-desc">插帧补帧,运动更流畅</div>
                  </div>
                  <label className="lxs-switch">
                    <input
                      type="checkbox"
                      checked={useRife}
                      onChange={(e) => setUseRife(e.target.checked)}
                    />
                    <span className="lxs-switch-track" />
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 生成按钮(固定底部) */}
        <div className="lxs-panel-foot">
          <button
            type="button"
            className="btn btn-primary lxs-generate-btn"
            onClick={handleGenerate}
            disabled={!canGenerate}
          >
            {busy ? (
              <>
                <Icon name="loading" size={16} />
                {uploading ? "上传中…" : submitting ? "提交中…" : "生成中…"}
              </>
            ) : (
              <>
                <Icon name="video" size={16} />
                生成视频
              </>
            )}
          </button>
          {error && !busy && (
            <div className="lxs-foot-error" role="alert">
              <Icon name="error" size={12} /> {error}
            </div>
          )}
        </div>
      </aside>

      <style jsx>{`
        .lxs-view {
          display: grid;
          grid-template-columns: 1fr var(--param-w);
          height: 100%;
          min-height: calc(100vh - var(--topbar-h));
          background: var(--bg-0);
        }

        /* ───── 左:画布 ───── */
        .lxs-canvas {
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
        .lxs-canvas-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--hairline);
          flex-shrink: 0;
        }
        .lxs-tabs {
          display: inline-flex;
          gap: 2px;
          padding: 3px;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
        }
        .lxs-tab {
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
        .lxs-tab:hover {
          color: var(--ink);
          background: var(--bg-2);
        }
        .lxs-tab.is-active {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .lxs-canvas-meta {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .lxs-stage {
          position: relative;
          flex: 1;
          min-height: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-5);
        }
        .lxs-empty {
          width: 100%;
          max-width: 480px;
        }

        .lxs-loading {
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lxs-loading-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-3);
        }
        .lxs-loading-orb {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: radial-gradient(circle at 35% 35%, var(--accent), transparent 70%);
          animation: lxs-pulse 1.6s var(--ease) infinite;
        }
        @keyframes lxs-pulse {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50% { transform: scale(1.18); opacity: 1; }
        }
        .lxs-loading-stage {
          font-size: 0.85rem;
          color: var(--ink-soft);
        }

        .lxs-result {
          width: 100%;
          max-width: 880px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lxs-video {
          width: 100%;
          max-height: calc(100vh - var(--topbar-h) - 140px);
          border-radius: var(--radius-md);
          border: 1px solid var(--hairline);
          background: #000;
        }
        .lxs-error-state {
          max-width: 480px;
        }

        /* ───── 右:参数面板 ───── */
        .lxs-panel {
          display: flex;
          flex-direction: column;
          min-height: 0;
          background: var(--bg-1);
        }
        .lxs-panel-scroll {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: var(--space-3);
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .lxs-section {
          padding: var(--space-3);
        }
        .lxs-label {
          display: block;
          font-size: 0.78rem;
          font-weight: 600;
          color: var(--ink-soft);
          margin-bottom: 0.45rem;
        }
        .lxs-select {
          width: 100%;
        }
        .lxs-textarea {
          width: 100%;
          resize: vertical;
          font-size: 0.85rem;
          line-height: 1.5;
        }
        .lxs-field-hint {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          margin-top: 0.45rem;
          font-size: 0.74rem;
          color: var(--warn);
        }

        /* LoRA 卡片 */
        .lxs-lora-list {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .lxs-lora-card {
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          padding: 0.45rem 0.55rem;
          background: var(--bg-0);
          transition: border-color var(--dur) var(--ease);
        }
        .lxs-lora-card.is-active {
          border-color: var(--accent-line);
          background: var(--accent-quiet);
        }
        .lxs-lora-card.is-disabled {
          opacity: 0.5;
        }
        .lxs-lora-head {
          display: flex;
          align-items: center;
          gap: 0.45rem;
          cursor: pointer;
          font-size: 0.8rem;
          color: var(--ink);
        }
        .lxs-lora-head input {
          accent-color: var(--accent);
        }
        .lxs-lora-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .lxs-lora-strength {
          display: grid;
          grid-template-columns: 1fr 40px;
          align-items: center;
          gap: 0.5rem;
          margin-top: 0.4rem;
        }
        .lxs-lora-strength input[type="range"] {
          width: 100%;
          accent-color: var(--accent);
        }
        .lxs-lora-val {
          font-size: 0.74rem;
          font-family: var(--font-mono);
          color: var(--ink-faint);
          text-align: right;
        }

        /* 折叠头 */
        .lxs-collapse-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          background: transparent;
          border: none;
          padding: 0;
          cursor: pointer;
        }
        .lxs-collapse-head .lxs-label {
          margin-bottom: 0;
        }
        .lxs-chevron {
          display: inline-block;
          color: var(--ink-faint);
          transform: rotate(-90deg);
          transition: transform var(--dur) var(--ease);
          font-size: 0.9rem;
        }
        .lxs-chevron.is-open {
          transform: rotate(0deg);
        }

        /* 上传 */
        .lxs-upload {
          border: 1px dashed var(--hairline-strong);
          border-radius: var(--radius-sm);
          padding: var(--space-3);
          cursor: pointer;
          transition: border-color var(--dur) var(--ease),
            background-color var(--dur) var(--ease);
        }
        .lxs-upload:hover,
        .lxs-upload.is-drag {
          border-color: var(--accent-line);
          background: var(--accent-quiet);
        }
        .lxs-upload-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.35rem;
          color: var(--ink-faint);
          font-size: 0.8rem;
          padding: var(--space-3) 0;
        }
        .lxs-upload-hint {
          font-size: 0.72rem;
        }
        .lxs-upload-preview img {
          width: 100%;
          border-radius: var(--radius-xs);
          display: block;
        }
        .lxs-upload-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-top: 0.4rem;
        }
        .lxs-upload-name {
          font-size: 0.74rem;
          color: var(--ink-faint);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* 预设 */
        .lxs-preset-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.4rem;
        }
        .lxs-preset-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.1rem;
          padding: 0.45rem 0.25rem;
          background: var(--bg-0);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink-soft);
          cursor: pointer;
          transition: border-color var(--dur) var(--ease),
            background-color var(--dur) var(--ease), color var(--dur) var(--ease);
        }
        .lxs-preset-btn:hover {
          color: var(--ink);
          border-color: var(--hairline-strong);
        }
        .lxs-preset-btn.is-active {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .lxs-preset-title {
          font-size: 0.8rem;
          font-weight: 600;
        }
        .lxs-preset-sub {
          font-size: 0.7rem;
          color: var(--ink-faint);
        }

        /* 高级参数 */
        .lxs-advanced-body {
          display: flex;
          flex-direction: column;
          gap: 0.7rem;
          margin-top: 0.6rem;
        }
        .lxs-num-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.5rem;
        }
        .lxs-num-field {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          font-size: 0.74rem;
          color: var(--ink-soft);
        }
        .lxs-seed-field {
          width: 100%;
        }

        /* 开关 */
        .lxs-toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .lxs-toggle-title {
          font-size: 0.8rem;
          color: var(--ink);
        }
        .lxs-toggle-desc {
          font-size: 0.72rem;
          color: var(--ink-faint);
        }
        .lxs-switch {
          position: relative;
          display: inline-block;
          width: 34px;
          height: 20px;
          flex-shrink: 0;
        }
        .lxs-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .lxs-switch-track {
          position: absolute;
          inset: 0;
          background: var(--bg-3);
          border-radius: var(--radius-full);
          transition: background-color var(--dur) var(--ease);
        }
        .lxs-switch-track::before {
          content: "";
          position: absolute;
          width: 14px;
          height: 14px;
          left: 3px;
          top: 3px;
          border-radius: 50%;
          background: var(--ink-faint);
          transition: transform var(--dur) var(--ease), background-color var(--dur) var(--ease);
        }
        .lxs-switch input:checked + .lxs-switch-track {
          background: var(--accent);
        }
        .lxs-switch input:checked + .lxs-switch-track::before {
          transform: translateX(14px);
          background: var(--accent-ink);
        }

        /* 底部 */
        .lxs-panel-foot {
          flex-shrink: 0;
          padding: var(--space-3);
          border-top: 1px solid var(--hairline);
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .lxs-generate-btn {
          width: 100%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
        }
        .lxs-foot-error {
          display: flex;
          align-items: flex-start;
          gap: 0.35rem;
          font-size: 0.76rem;
          color: var(--danger);
          line-height: 1.4;
          word-break: break-all;
        }

        @media (max-width: 900px) {
          .lxs-view {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(320px, 44vh) 1fr;
          }
          .lxs-canvas {
            border-right: none;
            border-bottom: 1px solid var(--hairline);
          }
        }
      `}</style>
    </div>
  );
}
