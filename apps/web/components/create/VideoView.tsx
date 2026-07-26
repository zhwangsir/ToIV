"use client";

import { useCallback, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { uploadImage, generateVideo, imageUrl, invalidateJobs } from "@/lib/api";
import { usePersistedGeneration } from "@/lib/gen-persist";

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

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

export function VideoView() {
  const GEN_SLOT = "video";

  const [positive, setPositive] = useState("");
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
  const [error, setError] = useState<string | null>(null);

  const imageInputRef = useRef<HTMLInputElement | null>(null);

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

  const handleImageSelect = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
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
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!positive.trim() || !uploadedFilename || !uploadedWorker) return;
    if (uploading || submitting || gen.isRunning) return;
    setSubmitting(true);
    setError(null);
    try {
      const s = seedLocked && seed ? parseInt(seed, 10) : randomSeed();
      const res = await generateVideo({
        positive: positive.trim(),
        image: uploadedFilename,
        worker: uploadedWorker,
        width,
        height,
        length,
        fps,
        seed: s,
      });
      await gen.start(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "视频生成失败");
    } finally {
      setSubmitting(false);
    }
  }, [positive, uploadedFilename, uploadedWorker, width, height, length, fps, seedLocked, seed, uploading, submitting, gen.isRunning, gen]);

  return (
    <div className="video-view">
      <div className="video-form">
        {/* 图片上传 */}
        <div
          className="video-upload"
          onClick={() => imageInputRef.current?.click()}
        >
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => handleImageSelect(e.target.files?.[0])}
          />
          {imagePreview ? (
            <img src={imagePreview} alt="reference" className="video-preview" />
          ) : (
            <div className="video-upload-placeholder">
              <Icon name="image" size={32} />
              <span>点击或拖拽上传参考图</span>
            </div>
          )}
        </div>

        {/* 提示词 */}
        <textarea
          className="video-prompt"
          placeholder="描述视频内容..."
          value={positive}
          onChange={(e) => setPositive(e.target.value)}
          rows={4}
        />

        {/* 分辨率 */}
        <div className="video-row">
          <span className="video-label">分辨率</span>
          <div className="video-presets">
            {RES_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`video-preset${width === p.w && height === p.h ? " is-active" : ""}`}
                onClick={() => { setWidth(p.w); setHeight(p.h); }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 时长 */}
        <div className="video-row">
          <span className="video-label">时长</span>
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

        {/* FPS */}
        <div className="video-row">
          <span className="video-label">FPS</span>
          <input
            type="number"
            className="video-number"
            value={fps}
            onChange={(e) => setFps(Math.max(4, Math.min(30, parseInt(e.target.value || "0", 10))))}
            min={4}
            max={30}
          />
        </div>

        {/* Seed */}
        <div className="video-row">
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

        {(error || gen.error) && <div className="video-error">{error || gen.error}</div>}

        <button
          type="button"
          className={`btn btn-primary video-submit${uploading || submitting || gen.isRunning ? " is-loading" : ""}`}
          onClick={handleGenerate}
          disabled={!positive.trim() || !uploadedFilename || uploading || submitting || gen.isRunning}
        >
          {(uploading || submitting || gen.isRunning) ? (
            <>
              <Icon name="loading" size={16} />
              {gen.isRunning
                ? `生成中 ${gen.progress.max > 0 ? Math.round((gen.progress.value / gen.progress.max) * 100) : 0}%`
                : submitting
                  ? "排队中"
                  : "上传中"}
            </>
          ) : (
            <>
              <Icon name="video" size={16} />
              生成视频
            </>
          )}
        </button>
      </div>

      {gen.status === "done" && gen.resultPaths[0] && (
        <div className="video-result">
          <video src={imageUrl(gen.resultPaths[0])} controls width="100%" />
        </div>
      )}

      <style jsx>{`
        .video-view { display: grid; gap: var(--space-4); max-width: 720px; }
        .video-form { display: grid; gap: var(--space-3); }
        .video-upload { aspect-ratio: 16/9; border: 2px dashed var(--hairline); border-radius: var(--radius-lg); display: grid; place-items: center; cursor: pointer; overflow: hidden; }
        .video-upload-placeholder { display: grid; place-items: center; gap: var(--space-2); color: var(--ink-soft); }
        .video-preview { width: 100%; height: 100%; object-fit: contain; }
        .video-prompt { background: var(--bg-1); border: 1px solid var(--hairline); border-radius: var(--radius-md); padding: var(--space-3); color: var(--ink); resize: vertical; }
        .video-row { display: flex; align-items: center; gap: var(--space-3); }
        .video-label { min-width: 60px; color: var(--ink-soft); font-size: 0.875rem; }
        .video-presets { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .video-preset { padding: var(--space-2) var(--space-3); background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius-md); color: var(--ink); cursor: pointer; }
        .video-preset.is-active { background: var(--accent); color: white; border-color: var(--accent); }
        .video-number { width: 100px; background: var(--bg-1); border: 1px solid var(--hairline); border-radius: var(--radius-md); padding: var(--space-2); color: var(--ink); }
        .video-check { display: flex; align-items: center; gap: var(--space-2); color: var(--ink); cursor: pointer; }
        .video-error { color: var(--danger); font-size: 0.875rem; }
        .video-submit {
          justify-self: start;
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
        }
        .video-result { border-radius: var(--radius-lg); overflow: hidden; }
      `}</style>
    </div>
  );
}
