"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { genId } from "@/lib/id";
import {
  animaticVideoUrl,
  createAnimatic,
  type AnimaticResult,
} from "@/lib/animatic";

// 与后端 apps/api/app/routes/animatic.py 保持一致的限制
const MAX_IMAGES = 20;
const MAX_BYTES = 20 * 1024 * 1024;
const EXT_OK = ["jpg", "jpeg", "png", "webp"];
const DEFAULT_DURATION = 3.0;

const RESOLUTIONS = [
  { label: "1080p · 1920×1080", width: 1920, height: 1080 },
  { label: "720p · 1280×720", width: 1280, height: 720 },
] as const;

type Item = {
  id: string;
  file: File;
  preview: string; // objectURL,移除/卸载时 revoke
  duration: number;
};

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function formatMB(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

export function AnimaticView() {
  const [items, setItems] = useState<Item[]>([]);
  const [fps, setFps] = useState(24);
  const [resIdx, setResIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnimaticResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 卸载时回收全部 objectURL
  useEffect(() => {
    return () => {
      setItems((prev) => {
        prev.forEach((it) => URL.revokeObjectURL(it.preview));
        return prev;
      });
    };
  }, []);

  const totalDuration = items.reduce((s, it) => s + (it.duration || 0), 0);

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      const picked = Array.from(files);
      if (items.length + picked.length > MAX_IMAGES) {
        setError(`最多 ${MAX_IMAGES} 张分镜图(当前 ${items.length} 张)`);
        return;
      }
      for (const f of picked) {
        if (!EXT_OK.includes(fileExt(f.name))) {
          setError(`「${f.name}」格式不支持(仅 jpg/png/webp)`);
          return;
        }
        if (f.size > MAX_BYTES) {
          setError(`「${f.name}」超过 20MB 上限(${formatMB(f.size)})`);
          return;
        }
      }
      const next = picked.map((file) => ({
        id: genId(),
        file,
        preview: URL.createObjectURL(file),
        duration: DEFAULT_DURATION,
      }));
      setItems((prev) => [...prev, ...next]);
      setResult(null);
    },
    [items.length],
  );

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const it = prev.find((x) => x.id === id);
      if (it) URL.revokeObjectURL(it.preview);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  const moveItem = useCallback((id: string, dir: -1 | 1) => {
    setItems((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const setDuration = useCallback((id: string, v: number) => {
    setItems((prev) =>
      prev.map((x) => (x.id === id ? { ...x, duration: v } : x)),
    );
  }, []);

  const submit = useCallback(async () => {
    if (items.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const res = RESOLUTIONS[resIdx];
    try {
      const data = await createAnimatic({
        images: items.map((it) => it.file),
        durations: items.map((it) => it.duration),
        fps,
        width: res.width,
        height: res.height,
      });
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      setBusy(false);
    }
  }, [items, fps, resIdx, busy]);

  return (
    <div className="single-view animatic-view">
      <header className="anim-header">
        <div>
          <h1 className="anim-title">动态分镜</h1>
          <p className="anim-subtitle">
            上传分镜图,设置每镜时长,串成一条可播放的 animatic 视频
          </p>
        </div>
        <div className="anim-header-right">
          <span className="badge">
            <Icon name="film" size={13} />
            {items.length} / {MAX_IMAGES} 镜 · 共 {totalDuration.toFixed(1)}s
          </span>
        </div>
      </header>

      <button
        type="button"
        className="anim-drop"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        <Icon name="upload" size={22} />
        <span className="anim-drop-title">点击选择分镜图(可多张)</span>
        <span className="anim-drop-hint">
          jpg / png / webp · 单张 ≤ 20MB · 最多 {MAX_IMAGES} 张 · 顺序即播放顺序
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = ""; // 允许重复选同一文件
        }}
      />

      {items.length > 0 && (
        <ul className="anim-grid">
          {items.map((it, idx) => (
            <li key={it.id} className="anim-card">
              <div className="anim-thumb-wrap">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.preview} alt={it.file.name} className="anim-thumb" />
                <span className="anim-idx">{idx + 1}</span>
              </div>
              <div className="anim-card-name" title={it.file.name}>
                {it.file.name}
              </div>
              <div className="anim-card-row">
                <label className="anim-dur">
                  <input
                    type="number"
                    className="input anim-dur-input"
                    min={0.5}
                    max={30}
                    step={0.5}
                    value={it.duration}
                    disabled={busy}
                    onChange={(e) => {
                      const v = Number.parseFloat(e.target.value);
                      setDuration(it.id, Number.isFinite(v) ? v : 0);
                    }}
                  />
                  <span className="anim-dur-unit">秒</span>
                </label>
                <div className="anim-card-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label="上移"
                    disabled={busy || idx === 0}
                    onClick={() => moveItem(it.id, -1)}
                  >
                    <Icon name="chevron-up" size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label="下移"
                    disabled={busy || idx === items.length - 1}
                    onClick={() => moveItem(it.id, 1)}
                  >
                    <Icon name="chevron-down" size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-danger"
                    aria-label="移除"
                    disabled={busy}
                    onClick={() => removeItem(it.id)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="anim-params">
        <label className="anim-field">
          <span className="anim-field-label">帧率 (fps)</span>
          <input
            type="number"
            className="input anim-fps-input"
            min={12}
            max={60}
            value={fps}
            disabled={busy}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              setFps(Number.isFinite(v) ? v : 24);
            }}
          />
        </label>
        <label className="anim-field">
          <span className="anim-field-label">分辨率</span>
          <select
            className="input"
            value={resIdx}
            disabled={busy}
            onChange={(e) => setResIdx(Number.parseInt(e.target.value, 10))}
          >
            {RESOLUTIONS.map((r, i) => (
              <option key={r.label} value={i}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <div className="anim-params-spacer" />
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={busy || items.length === 0}
          onClick={submit}
        >
          {busy ? (
            <>
              <Icon name="loading" size={16} />
              上传并生成中…
            </>
          ) : (
            <>
              <Icon name="clapperboard" size={16} />
              生成动态分镜
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="anim-error" role="alert">
          <Icon name="error" size={15} />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <section className="anim-result">
          <div className="anim-result-head">
            <Icon name="success" size={16} />
            <span>
              已生成 {result.duration.toFixed(1)}s 成片({result.width}×
              {result.height} · {result.fps}fps · {result.count} 镜)
            </span>
          </div>
          <video
            className="anim-video"
            controls
            playsInline
            preload="metadata"
            src={animaticVideoUrl(result.url)}
          />
        </section>
      )}
    </div>
  );
}
