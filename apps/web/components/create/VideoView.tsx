"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import {
  generateTxt2video,
  generateVideo,
  imageUrl,
  invalidateJobs,
  uploadImage,
} from "@/lib/api";
import { consumeEngineDraft } from "@/lib/engine";
import { usePersistedGeneration } from "@/lib/gen-persist";
import { optimizeWithAgent } from "@/lib/agents";

const RES_PRESETS = [
  { label: "832×480", w: 832, h: 480 },
  { label: "640×480", w: 640, h: 480 },
  { label: "1280×720", w: 1280, h: 720 },
] as const;

const LEN_PRESETS = [
  { label: "81 帧", length: 81 },
  { label: "49 帧", length: 49 },
  { label: "105 帧", length: 105 },
] as const;

const HISTORY_KEY = "toiv_video_history";
const HISTORY_LIMIT = 5;

interface HistoryItem {
  id: string;
  prompt: string;
  mode: "txt2video" | "img2video";
  path: string;
  width: number;
  height: number;
  length: number;
  fps: number;
  seed: number;
  createdAt: number;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

function formatDuration(frames: number, fps: number): string {
  const sec = frames / fps;
  return `${sec.toFixed(1)}s`;
}

// 上传校验:后端 /api/upload 上限 20MB;扩展名白名单与动态分镜页一致
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function VideoView() {
  const GEN_SLOT = "video";

  const engineDraft = useMemo(() => consumeEngineDraft(), []);
  const [mode, setMode] = useState<"txt2video" | "img2video">("img2video");
  const [positive, setPositive] = useState(
    engineDraft?.target === "video" ? engineDraft.prompt : "",
  );
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadedFilename, setUploadedFilename] = useState<string>("");
  const [uploadedWorker, setUploadedWorker] = useState<string>("");

  const [width, setWidth] = useState(832);
  const [height, setHeight] = useState(480);
  const [length, setLength] = useState(81);
  const [fps, setFps] = useState(16);
  const [seedLocked, setSeedLocked] = useState(false);
  const [seed, setSeed] = useState("");

  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const gen = usePersistedGeneration({
    slot: GEN_SLOT,
    onDone: (paths) => {
      if (paths.length === 0) {
        gen.setError("生成完成但未返回视频");
        return;
      }
      invalidateJobs();
      const item: HistoryItem = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        prompt: positive.trim(),
        mode,
        path: paths[0],
        width,
        height,
        length,
        fps,
        seed: gen.lastSeed ?? randomSeed(),
        createdAt: Date.now(),
      };
      setHistory((prev) => [item, ...prev].slice(0, HISTORY_LIMIT));
      writeHistory([item, ...history].slice(0, HISTORY_LIMIT));
    },
  });

  useEffect(() => {
    setHistory(readHistory());
  }, []);

  const handleImageSelect = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/") || !IMAGE_EXT_OK.includes(fileExt(file.name))) {
        setError(`「${file.name}」格式不支持(仅 jpg/png/webp)`);
        return;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        setError(`「${file.name}」超过 20MB 上限(${(file.size / 1024 / 1024).toFixed(1)} MB)`);
        return;
      }
      setImageFile(file);
      setImagePreview(URL.createObjectURL(file));
      setUploading(true);
      setError(null);
      try {
        const r = await uploadImage(file, "video");
        setUploadedFilename(r.filename);
        setUploadedWorker(r.worker);
      } catch (e) {
        setError(e instanceof Error ? e.message : "图片上传失败");
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const clearImage = useCallback(() => {
    setImageFile(null);
    setImagePreview(null);
    setUploadedFilename("");
    setUploadedWorker("");
    if (imageInputRef.current) imageInputRef.current.value = "";
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!positive.trim()) return;
    if (mode === "img2video" && !uploadedFilename) return;
    if (uploading || submitting || gen.isRunning || optimizing) return;
    setSubmitting(true);
    setError(null);
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

      const s = seedLocked && seed ? parseInt(seed, 10) : randomSeed();
      if (mode === "txt2video") {
        const res = await generateTxt2video({
          positive: prompt,
          width,
          height,
          length,
          fps,
          seed: s,
        });
        await gen.start(res);
      } else {
        const res = await generateVideo({
          positive: prompt,
          image: uploadedFilename,
          worker: uploadedWorker,
          width,
          height,
          length,
          fps,
          seed: s,
        });
        await gen.start(res);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "视频生成失败");
    } finally {
      setSubmitting(false);
    }
  }, [
    positive,
    mode,
    uploadedFilename,
    uploadedWorker,
    width,
    height,
    length,
    fps,
    seedLocked,
    seed,
    uploading,
    submitting,
    optimizing,
    gen.isRunning,
    gen,
  ]);

  const canSubmit =
    positive.trim() &&
    (mode === "txt2video" || !!uploadedFilename) &&
    !uploading &&
    !submitting &&
    !optimizing &&
    !gen.isRunning;

  const progressText =
    gen.progress.max > 0
      ? Math.round((gen.progress.value / gen.progress.max) * 100)
      : 0;

  return (
    <div className="video-view">
      {/* ── 左栏:参数面板 ── */}
      <aside className="video-sidebar">
        <div className="video-panel">
          {/* 模式切换 */}
          <div className="video-mode">
            <button
              type="button"
              className={`video-mode-btn${mode === "txt2video" ? " is-active" : ""}`}
              onClick={() => setMode("txt2video")}
            >
              文生视频
            </button>
            <button
              type="button"
              className={`video-mode-btn${mode === "img2video" ? " is-active" : ""}`}
              onClick={() => setMode("img2video")}
            >
              图生视频
            </button>
          </div>

          {/* 提示词 */}
          <div className="video-field">
            <label className="video-field-label">
              提示词
              <OptimizeButton
                prompt={positive}
                kind="video"
                onOptimized={(text) => setPositive(text)}
                disabled={optimizing || gen.isRunning}
              />
            </label>
            <textarea
              className="video-prompt"
              placeholder="描述视频内容..."
              value={positive}
              onChange={(e) => setPositive(e.target.value)}
              rows={4}
            />
          </div>

          {/* 参考图(仅在图生视频模式) */}
          {mode === "img2video" && (
            <div className="video-field">
              <label className="video-field-label">
                参考图
                <span className="video-optional">可选</span>
              </label>
              <div
                className="video-upload"
                onClick={() =>
                  !imagePreview && imageInputRef.current?.click()
                }
              >
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => handleImageSelect(e.target.files?.[0])}
                />
                {imagePreview ? (
                  <div className="video-upload-filled">
                    <img
                      src={imagePreview}
                      alt="reference"
                      className="video-preview-thumb"
                    />
                    <div className="video-upload-actions">
                      <button
                        type="button"
                        className="video-upload-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          imageInputRef.current?.click();
                        }}
                      >
                        更换
                      </button>
                      <button
                        type="button"
                        className="video-upload-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          clearImage();
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="video-upload-placeholder">
                    <Icon name="upload" size={20} />
                    <span>添加参考图</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 参数卡片 */}
          <div className="video-card">
            <div className="video-card-row">
              <span className="video-card-label">分辨率</span>
              <div className="video-presets">
                {RES_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`video-preset${width === p.w && height === p.h ? " is-active" : ""}`}
                    onClick={() => {
                      setWidth(p.w);
                      setHeight(p.h);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="video-card-row">
              <span className="video-card-label">时长</span>
              <div className="video-presets">
                {LEN_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`video-preset${length === p.length ? " is-active" : ""}`}
                    onClick={() => setLength(p.length)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="video-card-row">
              <span className="video-card-label">FPS</span>
              <input
                type="number"
                className="video-number"
                value={fps}
                onChange={(e) =>
                  setFps(
                    Math.max(
                      4,
                      Math.min(
                        30,
                        parseInt(e.target.value || "0", 10),
                      ),
                    ),
                  )
                }
                min={4}
                max={30}
              />
            </div>

            <div className="video-card-row">
              <label className="video-check">
                <input
                  type="checkbox"
                  checked={seedLocked}
                  onChange={(e) => setSeedLocked(e.target.checked)}
                />
                <span>固定种子</span>
              </label>
              {seedLocked && (
                <input
                  type="number"
                  className="video-number"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  placeholder="随机"
                />
              )}
            </div>
          </div>

          {(error || gen.error) && (
            <div className="video-error">{error || gen.error}</div>
          )}
        </div>

        <button
          type="button"
          className={`video-submit${!canSubmit || gen.isRunning ? " is-loading" : ""}`}
          onClick={handleGenerate}
          disabled={!canSubmit}
        >
          {gen.isRunning ? (
            <>
              <Icon name="loading" size={16} />
              <span>生成中 {progressText}%</span>
              <span
                className="video-submit-progress"
                style={{ width: `${progressText}%` }}
              />
            </>
          ) : optimizing ? (
            <>
              <Icon name="loading" size={16} />
              <span>优化提示词中</span>
            </>
          ) : submitting ? (
            <>
              <Icon name="loading" size={16} />
              <span>排队中</span>
            </>
          ) : (
            <>
              <Icon name="video" size={16} />
              <span>生成视频</span>
            </>
          )}
        </button>
      </aside>

      {/* ── 中间:预览区 ── */}
      <main className="video-stage">
        {gen.status === "done" && gen.resultPaths[0] ? (
          <div className="video-result">
            <video
              src={imageUrl(gen.resultPaths[0])}
              controls
              className="video-result-player"
            />
            <div className="video-result-meta">
              <span className="video-result-tag">
                {width}×{height}
              </span>
              <span className="video-result-tag">{length} 帧</span>
              <span className="video-result-tag">{fps} FPS</span>
              <span className="video-result-tag">
                {formatDuration(length, fps)}
              </span>
              {gen.lastSeed && (
                <span className="video-result-tag">seed {gen.lastSeed}</span>
              )}
            </div>
          </div>
        ) : gen.isRunning ? (
          <div className="video-empty">
            <div className="video-progress-ring">
              <svg viewBox="0 0 36 36">
                <path
                  className="video-progress-track"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
                <path
                  className="video-progress-fill"
                  strokeDasharray={`${progressText}, 100`}
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
              </svg>
              <span className="video-progress-text">{progressText}%</span>
            </div>
            <p className="video-empty-title">视频生成中</p>
            <p className="video-empty-sub">正在采样,请稍候...</p>
          </div>
        ) : imagePreview && mode === "img2video" ? (
          <div className="video-ref-stage">
            <div className="video-ref-badge">参考图</div>
            <img src={imagePreview} alt="reference" />
          </div>
        ) : (
          <div className="video-empty">
            <Icon name="video" size={48} />
            <p className="video-empty-title">
              {mode === "txt2video" ? "输入提示词开始创作" : "上传参考图或直接生成"}
            </p>
            <p className="video-empty-sub">
              当前模式:{mode === "txt2video" ? "文生视频" : "图生视频"}
            </p>
          </div>
        )}
      </main>

      {/* ── 右栏:状态与历史 ── */}
      <aside className="video-statusbar">
        <div className="video-status-card">
          <h3 className="video-status-title">当前任务</h3>
          {gen.isRunning ? (
            <div className="video-status-body">
              <span className="video-status-badge running">生成中</span>
              <div className="video-status-progress">
                <div
                  className="video-status-progress-fill"
                  style={{ width: `${progressText}%` }}
                />
              </div>
              <p className="video-status-detail">进度 {progressText}%</p>
            </div>
          ) : gen.status === "done" ? (
            <div className="video-status-body">
              <span className="video-status-badge done">已完成</span>
              <p className="video-status-detail">
                {formatDuration(length, fps)} · {width}×{height}
              </p>
              <button
                type="button"
                className="video-status-action"
                onClick={() => gen.reset()}
              >
                新建生成
              </button>
            </div>
          ) : gen.status === "error" ? (
            <div className="video-status-body">
              <span className="video-status-badge error">失败</span>
              <p className="video-status-detail">
                {gen.error || "生成失败,请重试"}
              </p>
              <button
                type="button"
                className="video-status-action"
                onClick={() => gen.reset()}
              >
                重试
              </button>
            </div>
          ) : (
            <div className="video-status-body">
              <span className="video-status-badge idle">待机</span>
              <p className="video-status-detail">准备就绪,可开始生成</p>
            </div>
          )}
        </div>

        <div className="video-history-card">
          <h3 className="video-status-title">最近生成</h3>
          {history.length === 0 ? (
            <p className="video-history-empty">暂无历史记录</p>
          ) : (
            <ul className="video-history-list">
              {history.map((item) => (
                <li key={item.id} className="video-history-item">
                  <video
                    src={imageUrl(item.path)}
                    className="video-history-thumb"
                    preload="metadata"
                    muted
                  />
                  <div className="video-history-info">
                    <p className="video-history-prompt" title={item.prompt}>
                      {item.prompt}
                    </p>
                    <p className="video-history-meta">
                      {item.width}×{item.height} · {item.length}帧 ·{" "}
                      {item.mode === "txt2video" ? "文生" : "图生"}
                    </p>
                  </div>
                  <a
                    href={imageUrl(item.path)}
                    download
                    className="video-history-download"
                    title="下载"
                  >
                    <Icon name="download" size={14} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <style jsx>{`
        .video-view {
          display: grid;
          grid-template-columns: 280px 1fr 260px;
          gap: var(--space-6);
          height: 100%;
          min-height: 0;
          overflow: hidden;
          padding: var(--space-4);
        }

        .video-sidebar {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }

        .video-panel {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          padding: var(--space-4);
        }

        .video-mode {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--space-2);
          padding: var(--space-1);
          background: var(--color-bg-subtle);
          border-radius: var(--radius-full);
        }

        .video-mode-btn {
          padding: var(--space-2) var(--space-3);
          border: none;
          border-radius: var(--radius-full);
          background: transparent;
          color: var(--color-text-secondary);
          font-size: var(--text-sm);
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
        }

        .video-mode-btn.is-active {
          background: var(--color-bg-elevated);
          color: var(--color-text-primary);
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
        }

        .video-field {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }

        .video-field-label {
          font-size: var(--text-sm);
          color: var(--color-text-secondary);
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }

        .video-optional {
          font-size: var(--text-xs);
          color: var(--color-text-tertiary);
          font-weight: 400;
        }

        .video-prompt {
          width: 100%;
          min-height: 96px;
          background: var(--color-bg-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: var(--space-3);
          color: var(--color-text-primary);
          font-size: var(--text-base);
          line-height: var(--leading-base);
          resize: vertical;
          outline: none;
        }

        .video-prompt::placeholder {
          color: var(--color-text-tertiary);
        }

        .video-prompt:focus {
          border-color: var(--color-accent-line);
        }

        .video-upload {
          position: relative;
          aspect-ratio: 16 / 9;
          max-height: 140px;
          border: 1px dashed var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-surface);
          overflow: hidden;
          cursor: pointer;
          display: grid;
          place-items: center;
          transition: border-color 0.15s, background 0.15s;
        }

        .video-upload:hover {
          border-color: var(--color-accent-line);
          background: var(--color-bg-subtle);
        }

        .video-upload-placeholder {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-2);
          color: var(--color-text-tertiary);
          font-size: var(--text-sm);
        }

        .video-upload-filled {
          position: relative;
          width: 100%;
          height: 100%;
        }

        .video-preview-thumb {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .video-upload-actions {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          background: rgba(0, 0, 0, 0.5);
          opacity: 0;
          transition: opacity 0.15s;
        }

        .video-upload-filled:hover .video-upload-actions {
          opacity: 1;
        }

        .video-upload-action {
          padding: var(--space-2) var(--space-3);
          background: var(--color-bg-elevated);
          border: none;
          border-radius: var(--radius-md);
          color: var(--color-text-primary);
          font-size: var(--text-sm);
          cursor: pointer;
        }

        .video-card {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-3);
          background: var(--color-bg-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
        }

        .video-card-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          min-height: 32px;
        }

        .video-card-label {
          min-width: 52px;
          font-size: var(--text-sm);
          color: var(--color-text-secondary);
        }

        .video-presets {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-2);
          flex: 1;
        }

        .video-preset {
          padding: var(--space-1) var(--space-3);
          background: var(--color-bg-subtle);
          border: 1px solid var(--color-border-subtle);
          border-radius: var(--radius-md);
          color: var(--color-text-secondary);
          font-size: var(--text-sm);
          cursor: pointer;
          transition: background 0.15s, color 0.15s, border-color 0.15s;
        }

        .video-preset.is-active {
          background: var(--color-accent-soft);
          color: var(--color-text-primary);
          border-color: var(--color-accent-line);
        }

        .video-number {
          width: 80px;
          padding: var(--space-1) var(--space-2);
          background: var(--color-bg-subtle);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          color: var(--color-text-primary);
          font-size: var(--text-sm);
          outline: none;
        }

        .video-number:focus {
          border-color: var(--color-accent-line);
        }

        .video-check {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          color: var(--color-text-secondary);
          font-size: var(--text-sm);
          cursor: pointer;
        }

        .video-error {
          padding: var(--space-3);
          background: var(--color-error-soft);
          border: 1px solid rgba(220, 38, 38, 0.2);
          border-radius: var(--radius-md);
          color: var(--color-error);
          font-size: var(--text-sm);
          line-height: var(--leading-md);
        }

        .video-submit {
          position: relative;
          flex: 0 0 auto;
          width: 100%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          background: var(--color-accent);
          color: var(--color-text-inverse);
          border: none;
          border-radius: var(--radius-md);
          font-size: var(--text-base);
          font-weight: 500;
          cursor: pointer;
          overflow: hidden;
          transition: background 0.15s;
        }

        .video-submit:hover:not(:disabled) {
          background: var(--color-accent-hover);
        }

        .video-submit:disabled {
          background: var(--color-bg-subtle);
          color: var(--color-text-tertiary);
          cursor: not-allowed;
        }

        .video-submit.is-loading {
          background: var(--color-bg-subtle);
          color: var(--color-text-primary);
        }

        .video-submit-progress {
          position: absolute;
          left: 0;
          bottom: 0;
          height: 3px;
          background: var(--color-accent);
          transition: width 0.2s linear;
        }

        .video-stage {
          display: grid;
          place-items: center;
          min-height: 0;
          overflow: hidden;
          background: var(--color-bg-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
        }

        .video-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          color: var(--color-text-tertiary);
          text-align: center;
          padding: var(--space-8);
        }

        .video-empty-title {
          color: var(--color-text-secondary);
          font-size: var(--text-lg);
          font-weight: 500;
          margin: 0;
        }

        .video-empty-sub {
          color: var(--color-text-tertiary);
          font-size: var(--text-sm);
          margin: 0;
        }

        .video-ref-stage {
          position: relative;
          width: 100%;
          height: 100%;
          display: grid;
          place-items: center;
          padding: var(--space-6);
        }

        .video-ref-stage img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          border-radius: var(--radius-md);
        }

        .video-ref-badge {
          position: absolute;
          top: var(--space-3);
          left: var(--space-3);
          padding: var(--space-1) var(--space-2);
          background: var(--color-bg-elevated);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          color: var(--color-text-secondary);
          font-size: var(--text-xs);
        }

        .video-result {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .video-result-player {
          flex: 1 1 auto;
          width: 100%;
          min-height: 0;
          background: #000;
        }

        .video-result-meta {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-2);
          padding: var(--space-3);
          border-top: 1px solid var(--color-border);
        }

        .video-result-tag {
          padding: var(--space-1) var(--space-2);
          background: var(--color-bg-subtle);
          border-radius: var(--radius-md);
          color: var(--color-text-secondary);
          font-size: var(--text-xs);
        }

        .video-progress-ring {
          position: relative;
          width: 96px;
          height: 96px;
        }

        .video-progress-ring svg {
          width: 100%;
          height: 100%;
          transform: rotate(-90deg);
        }

        .video-progress-track,
        .video-progress-fill {
          fill: none;
          stroke-width: 3;
          stroke-linecap: round;
        }

        .video-progress-track {
          stroke: var(--color-border);
        }

        .video-progress-fill {
          stroke: var(--color-accent);
          transition: stroke-dasharray 0.3s;
        }

        .video-progress-text {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          color: var(--color-text-primary);
          font-size: var(--text-lg);
          font-weight: 500;
        }

        .video-statusbar {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }

        .video-status-card,
        .video-history-card {
          background: var(--color-bg-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--space-4);
        }

        .video-status-title {
          margin: 0 0 var(--space-3);
          font-size: var(--text-sm);
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .video-status-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }

        .video-status-badge {
          align-self: flex-start;
          padding: var(--space-1) var(--space-2);
          border-radius: var(--radius-md);
          font-size: var(--text-xs);
          font-weight: 500;
        }

        .video-status-badge.idle {
          background: var(--color-bg-subtle);
          color: var(--color-text-secondary);
        }

        .video-status-badge.running {
          background: var(--color-info-soft);
          color: var(--color-info);
        }

        .video-status-badge.done {
          background: var(--color-success-soft);
          color: var(--color-success);
        }

        .video-status-badge.error {
          background: var(--color-error-soft);
          color: var(--color-error);
        }

        .video-status-progress {
          width: 100%;
          height: 4px;
          background: var(--color-bg-subtle);
          border-radius: var(--radius-full);
          overflow: hidden;
        }

        .video-status-progress-fill {
          height: 100%;
          background: var(--color-accent);
          transition: width 0.2s linear;
        }

        .video-status-detail {
          margin: 0;
          font-size: var(--text-sm);
          color: var(--color-text-secondary);
          line-height: var(--leading-md);
        }

        .video-status-action {
          align-self: flex-start;
          padding: var(--space-2) var(--space-3);
          background: var(--color-bg-subtle);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          color: var(--color-text-primary);
          font-size: var(--text-sm);
          cursor: pointer;
        }

        .video-history-card {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .video-history-empty {
          margin: 0;
          font-size: var(--text-sm);
          color: var(--color-text-tertiary);
        }

        .video-history-list {
          flex: 1 1 auto;
          overflow-y: auto;
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }

        .video-history-item {
          display: grid;
          grid-template-columns: 64px 1fr 28px;
          gap: var(--space-2);
          align-items: center;
        }

        .video-history-thumb {
          width: 64px;
          height: 36px;
          object-fit: cover;
          border-radius: var(--radius-md);
          background: var(--color-bg-subtle);
        }

        .video-history-info {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }

        .video-history-prompt {
          margin: 0;
          font-size: var(--text-sm);
          color: var(--color-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .video-history-meta {
          margin: 0;
          font-size: var(--text-xs);
          color: var(--color-text-tertiary);
        }

        .video-history-download {
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          color: var(--color-text-secondary);
          border-radius: var(--radius-md);
          transition: background 0.15s, color 0.15s;
        }

        .video-history-download:hover {
          background: var(--color-bg-subtle);
          color: var(--color-text-primary);
        }

        @media (max-width: 1024px) {
          .video-view {
            grid-template-columns: 1fr;
            grid-template-rows: auto 1fr auto;
            overflow: auto;
          }
          .video-sidebar,
          .video-statusbar {
            height: auto;
            overflow: visible;
          }
          .video-panel {
            overflow: visible;
          }
          .video-stage {
            min-height: 360px;
          }
          .video-history-card {
            max-height: 280px;
          }
        }
      `}</style>
    </div>
  );
}

function readHistory(): HistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryItem[];
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeHistory(items: HistoryItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}
