"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { genId } from "@/lib/id";
import {
  renderVideoEdit,
  videoEditOutputUrl,
  type VideoEditPlan,
  type VideoEditResult,
} from "@/lib/api";

// 与后端 apps/api/app/routes/video_edit.py 保持一致的限制
const MAX_MEDIA = 30;
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_CLIPS = 20;
const MAX_AUDIOS = 10;
const MAX_TEXTS = 20;
const MAX_TOTAL_SEC = 600;
const VIDEO_EXT = ["mp4", "webm", "mov", "mkv"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "ogg", "aac"];
const ACCEPT = [...VIDEO_EXT, ...AUDIO_EXT].map((e) => `.${e}`).join(",");
const FALLBACK_DURATION = 5; // 元数据读不到时的兜底时长(秒)
// 文字轨默认色:烧录进成片的渲染数据(随 plan 提交后端 ffmpeg drawtext,
// 必须是十六进制字面值),不是 UI 主题色,禁止换成 var() token
const DEFAULT_TEXT_COLOR = "#ffffff";

const RESOLUTIONS = [
  { label: "1080p · 1920×1080", width: 1920, height: 1080 },
  { label: "720p · 1280×720", width: 1280, height: 720 },
  { label: "竖屏 · 1080×1920", width: 1080, height: 1920 },
] as const;

const FPS_OPTIONS = [24, 30] as const;

type MediaKind = "video" | "audio";
type TextPosition = "top" | "center" | "bottom";

interface MediaItem {
  id: string;
  file: File;
  preview: string; // objectURL,清空/卸载时 revoke
  kind: MediaKind;
  duration: number | null; // 元数据探测结果,读取中为 null
}

interface ClipItem {
  id: string;
  file: number; // mediaFiles 下标(素材不删,下标稳定)
  in: number;
  duration: number;
  volume: number;
}

interface AudioItem {
  id: string;
  file: number;
  in: number;
  duration: number;
  start: number;
  volume: number;
}

interface TextItem {
  id: string;
  text: string;
  start: number;
  end: number;
  position: TextPosition;
  fontSize: number;
  color: string;
}

type Sel = { kind: "clip" | "audio" | "text"; id: string } | null;

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function formatMB(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

function fmtSec(d: number): string {
  return `${d.toFixed(1)}s`;
}

function toNum(raw: string, fallback: number): number {
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 读媒体元数据时长;失败/超时返回 null(调用方用兜底时长)。 */
function probeMediaDuration(url: string, kind: MediaKind): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    const timer = setTimeout(() => resolve(null), 5000);
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    };
    el.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    el.src = url;
  });
}

export function VideoEditView() {
  const [mediaFiles, setMediaFiles] = useState<MediaItem[]>([]);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [audios, setAudios] = useState<AudioItem[]>([]);
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [resIdx, setResIdx] = useState(0);
  const [fps, setFps] = useState<number>(30);
  const [sel, setSel] = useState<Sel>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoEditResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 卸载时回收全部 objectURL(ref 镜像避免闭包过期)
  const mediaRef = useRef<MediaItem[]>([]);
  useEffect(() => {
    mediaRef.current = mediaFiles;
  }, [mediaFiles]);
  useEffect(() => {
    return () => {
      mediaRef.current.forEach((m) => URL.revokeObjectURL(m.preview));
    };
  }, []);

  const totalSec = clips.reduce((s, c) => s + (c.duration || 0), 0);

  // 预览对象:显式选中 > 第一个视频素材
  const previewItem =
    mediaFiles.find((m) => m.id === previewId) ??
    mediaFiles.find((m) => m.kind === "video") ??
    null;

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0 || busy) return;
      setError(null);
      const picked = Array.from(files);
      if (mediaFiles.length + picked.length > MAX_MEDIA) {
        setError(`素材最多 ${MAX_MEDIA} 个(已有 ${mediaFiles.length} 个)`);
        return;
      }
      for (const f of picked) {
        const ext = fileExt(f.name);
        if (!VIDEO_EXT.includes(ext) && !AUDIO_EXT.includes(ext)) {
          setError(`「${f.name}」格式不支持(视频 mp4/webm/mov/mkv;音频 mp3/wav/m4a/ogg/aac)`);
          return;
        }
        if (f.size > MAX_BYTES) {
          setError(`「${f.name}」超过 500MB 上限(${formatMB(f.size)})`);
          return;
        }
      }
      const next: MediaItem[] = picked.map((file) => ({
        id: genId(),
        file,
        preview: URL.createObjectURL(file),
        kind: VIDEO_EXT.includes(fileExt(file.name)) ? "video" : "audio",
        duration: null,
      }));
      setMediaFiles((prev) => [...prev, ...next]);
      setResult(null);
      // 首个素材自动进预览(优先视频)
      setPreviewId(
        (prev) => prev ?? next.find((m) => m.kind === "video")?.id ?? next[0]?.id ?? null,
      );
      // 后台逐个探测时长,完成即回填素材卡片
      for (const item of next) {
        void probeMediaDuration(item.preview, item.kind).then((d) => {
          if (d != null) {
            setMediaFiles((prev) =>
              prev.map((m) => (m.id === item.id ? { ...m, duration: d } : m)),
            );
          }
        });
      }
    },
    [mediaFiles.length, busy],
  );

  const clearAll = useCallback(() => {
    if (busy) return;
    mediaFiles.forEach((m) => URL.revokeObjectURL(m.preview));
    setMediaFiles([]);
    setClips([]);
    setAudios([]);
    setTexts([]);
    setSel(null);
    setPreviewId(null);
    setResult(null);
    setError(null);
  }, [mediaFiles, busy]);

  // ── 轨道操作 ──

  const addClipToTrack = useCallback(
    (idx: number) => {
      if (busy) return;
      setError(null);
      const m = mediaFiles[idx];
      if (!m || m.kind !== "video") return;
      if (clips.length >= MAX_CLIPS) {
        setError(`视频轨最多 ${MAX_CLIPS} 段`);
        return;
      }
      const clip: ClipItem = {
        id: genId(),
        file: idx,
        in: 0,
        duration: m.duration ?? FALLBACK_DURATION,
        volume: 1,
      };
      setClips((prev) => [...prev, clip]);
      setSel({ kind: "clip", id: clip.id });
    },
    [busy, mediaFiles, clips.length],
  );

  const addAudioToTrack = useCallback(
    (idx: number) => {
      if (busy) return;
      setError(null);
      const m = mediaFiles[idx];
      if (!m || m.kind !== "audio") return;
      if (audios.length >= MAX_AUDIOS) {
        setError(`音频轨最多 ${MAX_AUDIOS} 段`);
        return;
      }
      const audio: AudioItem = {
        id: genId(),
        file: idx,
        in: 0,
        duration: m.duration ?? FALLBACK_DURATION,
        start: 0,
        volume: 1,
      };
      setAudios((prev) => [...prev, audio]);
      setSel({ kind: "audio", id: audio.id });
    },
    [busy, mediaFiles, audios.length],
  );

  const addText = useCallback(() => {
    if (busy) return;
    setError(null);
    if (texts.length >= MAX_TEXTS) {
      setError(`文字轨最多 ${MAX_TEXTS} 条`);
      return;
    }
    const t: TextItem = {
      id: genId(),
      text: "新文字",
      start: 0,
      end: 3,
      position: "bottom",
      fontSize: 48,
      color: DEFAULT_TEXT_COLOR,
    };
    setTexts((prev) => [...prev, t]);
    setSel({ kind: "text", id: t.id });
  }, [busy, texts.length]);

  const updateClip = useCallback((id: string, patch: Partial<Omit<ClipItem, "id" | "file">>) => {
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const updateAudio = useCallback((id: string, patch: Partial<Omit<AudioItem, "id" | "file">>) => {
    setAudios((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const updateText = useCallback((id: string, patch: Partial<Omit<TextItem, "id">>) => {
    setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const moveClip = useCallback((id: string, dir: -1 | 1) => {
    setClips((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const moveAudio = useCallback((id: string, dir: -1 | 1) => {
    setAudios((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const removeClip = useCallback((id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
    setSel((prev) => (prev?.kind === "clip" && prev.id === id ? null : prev));
  }, []);

  const removeAudio = useCallback((id: string) => {
    setAudios((prev) => prev.filter((a) => a.id !== id));
    setSel((prev) => (prev?.kind === "audio" && prev.id === id ? null : prev));
  }, []);

  const removeText = useCallback((id: string) => {
    setTexts((prev) => prev.filter((t) => t.id !== id));
    setSel((prev) => (prev?.kind === "text" && prev.id === id ? null : prev));
  }, []);

  // ── 导出 ──

  const invalidTextRange = texts.some((t) => !(t.end > t.start));
  const emptyTextContent = texts.some((t) => !t.text.trim());
  const exportBlock: string | null =
    clips.length === 0
      ? "请先把至少一个视频素材加入视频轨"
      : invalidTextRange
        ? "文字轨存在「结束 ≤ 开始」的条目,请修正"
        : emptyTextContent
          ? "文字轨存在空内容条目,请填写或删除"
          : totalSec > MAX_TOTAL_SEC
            ? `成片总时长 ${totalSec.toFixed(1)}s 超过 ${MAX_TOTAL_SEC}s 上限,请缩减片段`
            : null;

  const submit = useCallback(async () => {
    if (busy || exportBlock) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const res = RESOLUTIONS[resIdx];
    try {
      const plan: VideoEditPlan = {
        width: res.width,
        height: res.height,
        fps,
        clips: clips.map((c) => ({
          file: c.file,
          in: c.in,
          duration: c.duration,
          volume: c.volume,
        })),
        audios: audios.map((a) => ({
          file: a.file,
          in: a.in,
          duration: a.duration,
          start: a.start,
          volume: a.volume,
        })),
        texts: texts.map((t) => ({
          text: t.text.trim(),
          start: t.start,
          end: t.end,
          position: t.position,
          fontSize: t.fontSize,
          color: t.color,
        })),
      };
      const data = await renderVideoEdit(plan, mediaFiles.map((m) => m.file));
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "视频渲染失败");
    } finally {
      setBusy(false);
    }
  }, [busy, exportBlock, resIdx, fps, clips, audios, texts, mediaFiles]);

  return (
    <div className="single-view ve-view">
      <header className="page-header">
        <div>
          <h1 className="page-header-title">视频剪辑</h1>
          <p className="page-header-desc">
            时间线剪辑:拼接视频片段、叠加音频与文字,本地集群渲染导出成片
          </p>
        </div>
        <div className="page-header-actions ve-settings">
          <label className="ve-setting">
            <span>分辨率</span>
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
          <label className="ve-setting">
            <span>帧率</span>
            <select
              className="input"
              value={fps}
              disabled={busy}
              onChange={(e) => setFps(Number.parseInt(e.target.value, 10))}
            >
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {/* 窄屏兜底提示(同画布策略):≤767 显示,时间线编辑建议大屏 */}
      <p className="ve-mobile-note">
        <Icon name="info" size={13} />
        当前屏幕较窄,时间线可横向滑动编辑;建议使用平板或桌面端获得完整剪辑体验
      </p>

      <div className="ve-main">
        {/* ── 预览(视觉中心,宽列在前) ── */}
        <section className="card ve-preview">
          <div className="ve-panel-title">
            <span className="ve-panel-name">
              <Icon name="play" size={14} />
              预览
            </span>
            {previewItem && (
              <span className="ve-preview-name" title={previewItem.file.name}>
                {previewItem.file.name}
              </span>
            )}
          </div>
          {previewItem ? (
            previewItem.kind === "video" ? (
              <video
                key={previewItem.id}
                className="ve-preview-video"
                controls
                playsInline
                preload="metadata"
                src={previewItem.preview}
              />
            ) : (
              <div className="ve-preview-audio">
                <Icon name="audio" size={32} />
                <audio key={previewItem.id} controls preload="metadata" src={previewItem.preview} />
                <span className="ve-preview-audio-hint">音频素材仅提供试听,不影响时间线</span>
              </div>
            )
          ) : (
            <Empty
              icon="film"
              title="暂无预览"
              desc="导入素材后,点击素材或时间线片段即可预览"
            />
          )}
        </section>

        {/* ── 素材库 ── */}
        <section className="card ve-media">
          <div className="ve-panel-title">
            <span className="ve-panel-name">
              <Icon name="upload" size={14} />
              素材库
            </span>
            <span className="ve-panel-side">
              <span className="badge">{mediaFiles.length} / {MAX_MEDIA}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={
                  busy ||
                  (mediaFiles.length === 0 &&
                    clips.length === 0 &&
                    audios.length === 0 &&
                    texts.length === 0)
                }
                onClick={clearAll}
              >
                <Icon name="refresh" size={13} />
                清空重来
              </button>
            </span>
          </div>

          <button
            type="button"
            className="ve-import"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Icon name="plus" size={16} />
            <span className="ve-import-title">导入素材(可多选)</span>
            <span className="ve-import-hint">
              视频 mp4/webm/mov/mkv · 音频 mp3/wav/m4a/ogg/aac · 单个 ≤ 500MB
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = ""; // 允许重复选同一文件
            }}
          />

          {mediaFiles.length > 0 && (
            <ul className="ve-media-list">
              {mediaFiles.map((m, idx) => (
                <li
                  key={m.id}
                  className={`ve-media-item${previewItem?.id === m.id ? " is-sel" : ""}`}
                  onClick={() => setPreviewId(m.id)}
                >
                  <span className="ve-media-icon">
                    <Icon name={m.kind === "video" ? "video" : "audio"} size={16} />
                  </span>
                  <span className="ve-media-info">
                    <span className="ve-media-name" title={m.file.name}>
                      {m.file.name}
                    </span>
                    <span className="ve-media-meta">
                      {m.kind === "video" ? "视频" : "音频"} ·{" "}
                      {m.duration != null ? fmtSec(m.duration) : "读取中…"} ·{" "}
                      {formatMB(m.file.size)}
                    </span>
                  </span>
                  {m.kind === "video" ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || clips.length >= MAX_CLIPS}
                      onClick={(e) => {
                        e.stopPropagation();
                        addClipToTrack(idx);
                      }}
                    >
                      加入视频轨
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || audios.length >= MAX_AUDIOS}
                      onClick={(e) => {
                        e.stopPropagation();
                        addAudioToTrack(idx);
                      }}
                    >
                      加入音频轨
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

      </div>

      {/* ── 时间线 ── */}
      <section className="card ve-timeline">
        <div className="ve-panel-title">
          <span className="ve-panel-name">
            <Icon name="layers" size={14} />
            时间线
          </span>
          <span className="badge">
            <Icon name="film" size={13} />
            共 {totalSec.toFixed(1)}s
          </span>
        </div>

        {/* 视频轨 */}
        <div className="ve-tl-row">
          <div className="ve-tl-label">
            <span className="ve-tl-label-name">
              <Icon name="video" size={14} />
              <span>视频轨</span>
            </span>
          </div>
          <div className="ve-tl-track">
            {clips.length === 0 && (
              <span className="ve-tl-empty">从素材库点「加入视频轨」,片段按顺序串接</span>
            )}
            {clips.map((c, i) => {
              const m = mediaFiles[c.file];
              const selected = sel?.kind === "clip" && sel.id === c.id;
              return (
                <div
                  key={c.id}
                  className={`ve-clip${selected ? " is-sel" : ""}`}
                  onClick={() => {
                    setSel({ kind: "clip", id: c.id });
                    if (m) setPreviewId(m.id);
                  }}
                >
                  <div className="ve-clip-head">
                    <span className="ve-clip-name" title={m?.file.name ?? ""}>
                      #{i + 1} {m?.file.name ?? `素材 ${c.file + 1}`}
                    </span>
                    <span className="ve-clip-dur">{fmtSec(c.duration)}</span>
                  </div>
                  {selected && (
                    <div className="ve-clip-edit" onClick={(e) => e.stopPropagation()}>
                      <label className="ve-field">
                        <span>入点(s)</span>
                        <input
                          type="number"
                          className="input"
                          min={0}
                          step={0.1}
                          value={c.in}
                          disabled={busy}
                          onChange={(e) =>
                            updateClip(c.id, { in: Math.max(0, toNum(e.target.value, c.in)) })
                          }
                        />
                      </label>
                      <label className="ve-field">
                        <span>时长(s)</span>
                        <input
                          type="number"
                          className="input"
                          min={0.1}
                          step={0.1}
                          value={c.duration}
                          disabled={busy}
                          onChange={(e) =>
                            updateClip(c.id, {
                              duration: Math.max(0.1, toNum(e.target.value, c.duration)),
                            })
                          }
                        />
                      </label>
                      <label className="ve-field">
                        <span>音量(0=丢弃原声)</span>
                        <input
                          type="number"
                          className="input"
                          min={0}
                          max={1}
                          step={0.1}
                          value={c.volume}
                          disabled={busy}
                          onChange={(e) =>
                            updateClip(c.id, {
                              volume: clamp(toNum(e.target.value, c.volume), 0, 1),
                            })
                          }
                        />
                      </label>
                      <div className="ve-clip-actions">
                        <button
                          type="button"
                          className="ve-mini-btn"
                          aria-label="左移"
                          disabled={busy || i === 0}
                          onClick={() => moveClip(c.id, -1)}
                        >
                          <Icon name="chevron-left" size={14} />
                        </button>
                        <button
                          type="button"
                          className="ve-mini-btn"
                          aria-label="右移"
                          disabled={busy || i === clips.length - 1}
                          onClick={() => moveClip(c.id, 1)}
                        >
                          <Icon name="chevron-right" size={14} />
                        </button>
                        <button
                          type="button"
                          className="ve-mini-btn is-danger"
                          aria-label="删除片段"
                          disabled={busy}
                          onClick={() => removeClip(c.id)}
                        >
                          <Icon name="delete" size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 音频轨 */}
        <div className="ve-tl-row">
          <div className="ve-tl-label">
            <span className="ve-tl-label-name">
              <Icon name="audio" size={14} />
              <span>音频轨</span>
            </span>
          </div>
          <div className="ve-tl-track">
            {audios.length === 0 && (
              <span className="ve-tl-empty">可选:从素材库点「加入音频轨」叠加配乐/旁白</span>
            )}
            {audios.map((a, i) => {
              const m = mediaFiles[a.file];
              const selected = sel?.kind === "audio" && sel.id === a.id;
              return (
                <div
                  key={a.id}
                  className={`ve-clip ve-audio${selected ? " is-sel" : ""}`}
                  onClick={() => {
                    setSel({ kind: "audio", id: a.id });
                    if (m) setPreviewId(m.id);
                  }}
                >
                  <div className="ve-clip-head">
                    <span className="ve-clip-name" title={m?.file.name ?? ""}>
                      #{i + 1} {m?.file.name ?? `素材 ${a.file + 1}`}
                    </span>
                    <span className="ve-clip-dur">{fmtSec(a.duration)}</span>
                  </div>
                  {selected && (
                    <div className="ve-clip-edit" onClick={(e) => e.stopPropagation()}>
                      <label className="ve-field">
                        <span>起点(s)</span>
                        <input
                          type="number"
                          className="input"
                          min={0}
                          step={0.1}
                          value={a.start}
                          disabled={busy}
                          onChange={(e) =>
                            updateAudio(a.id, {
                              start: Math.max(0, toNum(e.target.value, a.start)),
                            })
                          }
                        />
                      </label>
                      <label className="ve-field">
                        <span>入点(s)</span>
                        <input
                          type="number"
                          className="input"
                          min={0}
                          step={0.1}
                          value={a.in}
                          disabled={busy}
                          onChange={(e) =>
                            updateAudio(a.id, { in: Math.max(0, toNum(e.target.value, a.in)) })
                          }
                        />
                      </label>
                      <label className="ve-field">
                        <span>时长(s)</span>
                        <input
                          type="number"
                          className="input"
                          min={0.1}
                          step={0.1}
                          value={a.duration}
                          disabled={busy}
                          onChange={(e) =>
                            updateAudio(a.id, {
                              duration: Math.max(0.1, toNum(e.target.value, a.duration)),
                            })
                          }
                        />
                      </label>
                      <label className="ve-field">
                        <span>音量(0-1)</span>
                        <input
                          type="number"
                          className="input"
                          min={0}
                          max={1}
                          step={0.1}
                          value={a.volume}
                          disabled={busy}
                          onChange={(e) =>
                            updateAudio(a.id, {
                              volume: clamp(toNum(e.target.value, a.volume), 0, 1),
                            })
                          }
                        />
                      </label>
                      <div className="ve-clip-actions">
                        <button
                          type="button"
                          className="ve-mini-btn"
                          aria-label="左移"
                          disabled={busy || i === 0}
                          onClick={() => moveAudio(a.id, -1)}
                        >
                          <Icon name="chevron-left" size={14} />
                        </button>
                        <button
                          type="button"
                          className="ve-mini-btn"
                          aria-label="右移"
                          disabled={busy || i === audios.length - 1}
                          onClick={() => moveAudio(a.id, 1)}
                        >
                          <Icon name="chevron-right" size={14} />
                        </button>
                        <button
                          type="button"
                          className="ve-mini-btn is-danger"
                          aria-label="删除音频"
                          disabled={busy}
                          onClick={() => removeAudio(a.id)}
                        >
                          <Icon name="delete" size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 文字轨 */}
        <div className="ve-tl-row">
          <div className="ve-tl-label">
            <span className="ve-tl-label-name">
              <Icon name="type" size={14} />
              <span>文字轨</span>
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm ve-add-text"
              disabled={busy || texts.length >= MAX_TEXTS}
              onClick={addText}
            >
              <Icon name="plus" size={13} />
              添加文字
            </button>
          </div>
          <div className="ve-tl-track">
            {texts.length === 0 && (
              <span className="ve-tl-empty">可选:点左侧「添加文字」叠加标题/字幕</span>
            )}
            {texts.map((t) => {
              const selected = sel?.kind === "text" && sel.id === t.id;
              const bad = !(t.end > t.start);
              return (
                <div
                  key={t.id}
                  className={`ve-clip ve-text${selected ? " is-sel" : ""}${bad ? " is-bad" : ""}`}
                  onClick={() => setSel({ kind: "text", id: t.id })}
                >
                  <div className="ve-clip-head">
                    <span className="ve-clip-name" title={t.text}>
                      {t.text.trim() || "(空文字)"}
                    </span>
                    <span className="ve-clip-dur">
                      {t.start}-{t.end}s
                    </span>
                  </div>
                  {selected && (
                    <div className="ve-clip-edit" onClick={(e) => e.stopPropagation()}>
                      <label className="ve-field ve-field-wide">
                        <span>内容</span>
                        <input
                          type="text"
                          className="input"
                          maxLength={200}
                          value={t.text}
                          disabled={busy}
                          onChange={(e) => updateText(t.id, { text: e.target.value })}
                        />
                      </label>
                      <label className="ve-field">
                        <span>开始(s)</span>
                        <input
                          type="number"
                          className="input"
                          min={0}
                          step={0.1}
                          value={t.start}
                          disabled={busy}
                          onChange={(e) =>
                            updateText(t.id, {
                              start: Math.max(0, toNum(e.target.value, t.start)),
                            })
                          }
                        />
                      </label>
                      <label className="ve-field">
                        <span>结束(s)</span>
                        <input
                          type="number"
                          className="input"
                          min={0.1}
                          step={0.1}
                          value={t.end}
                          disabled={busy}
                          onChange={(e) =>
                            updateText(t.id, {
                              end: Math.max(0.1, toNum(e.target.value, t.end)),
                            })
                          }
                        />
                      </label>
                      <label className="ve-field">
                        <span>位置</span>
                        <select
                          className="input"
                          value={t.position}
                          disabled={busy}
                          onChange={(e) =>
                            updateText(t.id, { position: e.target.value as TextPosition })
                          }
                        >
                          <option value="top">顶部</option>
                          <option value="center">居中</option>
                          <option value="bottom">底部</option>
                        </select>
                      </label>
                      <label className="ve-field">
                        <span>字号</span>
                        <input
                          type="number"
                          className="input"
                          min={12}
                          max={200}
                          step={1}
                          value={t.fontSize}
                          disabled={busy}
                          onChange={(e) =>
                            updateText(t.id, {
                              fontSize: Math.round(
                                clamp(toNum(e.target.value, t.fontSize), 12, 200),
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="ve-field">
                        <span>颜色</span>
                        <input
                          type="color"
                          className="ve-color"
                          value={t.color}
                          disabled={busy}
                          onChange={(e) => updateText(t.id, { color: e.target.value })}
                        />
                      </label>
                      <div className="ve-clip-actions">
                        <button
                          type="button"
                          className="ve-mini-btn is-danger"
                          aria-label="删除文字"
                          disabled={busy}
                          onClick={() => removeText(t.id)}
                        >
                          <Icon name="delete" size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {error && (
        <ErrorBar message={error} onClose={() => setError(null)} />
      )}

      {/* ── 导出 ── */}
      <footer className="ve-footer">
        <div className="ve-footer-info">
          {exportBlock ? (
            <span className="ve-footer-hint">
              <Icon name="info" size={13} />
              {exportBlock}
            </span>
          ) : (
            <span>
              {clips.length} 视频片段 / {audios.length} 音频 / {texts.length} 文字 · 共{" "}
              {totalSec.toFixed(1)}s
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={busy || exportBlock != null}
          onClick={submit}
        >
          {busy ? (
            <>
              <Icon name="loading" size={16} />
              渲染中,请稍候…
            </>
          ) : (
            <>
              <Icon name="scissors" size={16} />
              导出视频
            </>
          )}
        </button>
      </footer>

      {result && (
        <section className="card ve-result">
          <div className="ve-result-head">
            <Icon name="success" size={16} />
            <span>
              渲染完成:{result.duration.toFixed(1)}s · {result.width}×{result.height} ·{" "}
              {result.fps}fps · {result.clips} 片段 / {result.audios} 音频 / {result.texts} 文字
            </span>
          </div>
          <video
            className="ve-result-video"
            controls
            playsInline
            preload="metadata"
            src={videoEditOutputUrl(result.url)}
          />
          <div className="ve-result-actions">
            <a
              className="btn btn-primary"
              href={videoEditOutputUrl(result.url)}
              download={`toiv-edit-${result.job_id}.mp4`}
            >
              <Icon name="download" size={16} />
              下载成片
            </a>
          </div>
        </section>
      )}

      <style jsx>{`
        .ve-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-8);
        }
        /* 页头改用全局 .page-header 系列类(含 CornerNav 避让),本地只保留设置组样式 */
        .ve-settings {
          display: flex;
          gap: var(--space-3);
          align-items: flex-end;
        }
        .ve-setting {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          font-size: var(--text-xs);
          font-weight: 500;
          color: var(--text-secondary);
        }
        .ve-setting select {
          min-width: 160px;
        }
        /* 窄屏兜底提示条:桌面端隐藏,≤767 显示(见底部媒体查询) */
        .ve-mobile-note {
          display: none;
          align-items: center;
          gap: var(--space-2);
          margin: 0;
          padding: var(--space-2) var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.5;
        }
        .ve-mobile-note :global(svg) {
          flex-shrink: 0;
          color: var(--text-secondary);
        }
        .ve-main {
          display: grid;
          /* 预览宽列在前做视觉中心,素材库收敛为右侧 340px 侧栏 */
          grid-template-columns: minmax(0, 1fr) 340px;
          gap: var(--space-6);
          align-items: start;
        }
        /* 三区面板统一加厚内边距(16→24),拉开与全局 .card 默认值的层级 */
        .ve-preview,
        .ve-media,
        .ve-timeline {
          padding: var(--space-6);
        }
        /* 预览区常驻升浮,成为页面视觉中心 */
        .ve-preview {
          box-shadow: var(--shadow-md);
        }
        .ve-panel-title {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
          margin-bottom: var(--space-5);
          padding-bottom: var(--space-3);
          border-bottom: 1px solid var(--border-subtle);
          font-size: var(--text-section);
          font-weight: 600;
          color: var(--text-primary);
        }
        .ve-panel-name {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
        }
        .ve-panel-side {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
        }
        .ve-import {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-2);
          width: 100%;
          padding: var(--space-6) var(--space-4);
          border: 1px dashed var(--border-strong);
          border-radius: var(--radius-control);
          background: var(--bg-surface-2);
          color: var(--text-secondary);
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .ve-import:hover:not(:disabled) {
          border-color: var(--accent);
          background: var(--accent-soft);
          color: var(--text-primary);
        }
        .ve-import:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .ve-import:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .ve-import-title {
          font-size: var(--text-sm);
          font-weight: 500;
          color: var(--text-primary);
        }
        .ve-import-hint {
          font-size: var(--text-xs);
          color: var(--text-muted);
          text-align: center;
        }
        .ve-media-list {
          margin-top: var(--space-4);
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          max-height: 480px;
          overflow-y: auto;
        }
        .ve-media-item {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-4);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-2);
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        /* 卡片 hover 升浮反馈 */
        .ve-media-item:hover {
          border-color: var(--border-strong);
          background: var(--bg-surface-3);
          transform: translateY(-1px);
          box-shadow: var(--shadow-sm);
        }
        .ve-media-item.is-sel {
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .ve-media-icon {
          display: inline-flex;
          color: var(--text-secondary);
          flex-shrink: 0;
        }
        .ve-media-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .ve-media-name {
          font-size: var(--text-sm);
          font-weight: 500;
          line-height: 1.4;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ve-media-meta {
          font-size: var(--text-xs);
          color: var(--text-muted);
        }
        .ve-preview {
          min-height: 320px;
        }
        .ve-preview :global(.empty-state) {
          min-height: 280px;
          padding: var(--space-10) var(--space-4);
        }
        .ve-preview-name {
          font-size: var(--text-xs);
          color: var(--text-muted);
          max-width: 50%;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ve-preview-video {
          width: 100%;
          max-height: 520px;
          border-radius: var(--radius-control);
          background: var(--bg-canvas);
        }
        .ve-preview-audio {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-10) var(--space-4);
          color: var(--text-secondary);
        }
        .ve-preview-audio audio {
          width: 100%;
        }
        .ve-preview-audio-hint {
          font-size: var(--text-xs);
          color: var(--text-muted);
        }
        .ve-timeline {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        /* 时间线卡用 flex gap 控制节奏,面板标题不再叠加 margin(分隔线由 padding-bottom 承载) */
        .ve-timeline .ve-panel-title {
          margin-bottom: 0;
        }
        .ve-tl-row {
          display: flex;
          gap: var(--space-3);
          align-items: stretch;
        }
        .ve-tl-label {
          width: 96px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: center;
          gap: var(--space-1);
          font-size: var(--text-xs);
          color: var(--text-secondary);
        }
        .ve-tl-label-name {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-weight: 500;
        }
        .ve-add-text {
          margin-top: var(--space-1);
        }
        .ve-tl-track {
          flex: 1;
          min-width: 0;
          display: flex;
          gap: var(--space-3);
          align-items: stretch;
          overflow-x: auto;
          padding: var(--space-3);
          min-height: 80px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-3);
        }
        .ve-tl-empty {
          align-self: center;
          padding: 0 var(--space-2);
          font-size: var(--text-xs);
          color: var(--text-muted);
        }
        .ve-clip {
          flex-shrink: 0;
          min-width: 150px;
          max-width: 320px;
          padding: var(--space-3) var(--space-4);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-2);
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .ve-clip:hover {
          border-color: var(--border-strong);
          background: var(--bg-surface-3);
          transform: translateY(-1px);
          box-shadow: var(--shadow-sm);
        }
        .ve-clip.is-sel {
          border-color: var(--accent);
          box-shadow: 0 0 0 1px var(--accent);
        }
        .ve-clip.is-sel:hover {
          background: var(--bg-surface-2);
        }
        .ve-clip.is-bad {
          border-color: var(--err);
        }
        .ve-clip-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .ve-clip-name {
          font-size: var(--text-sm);
          font-weight: 500;
          line-height: 1.4;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ve-clip-dur {
          flex-shrink: 0;
          font-size: var(--text-xs);
          color: var(--text-muted);
        }
        .ve-clip-edit {
          margin-top: var(--space-2);
          padding-top: var(--space-2);
          border-top: 1px solid var(--border-subtle);
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-2);
          cursor: default;
        }
        .ve-field {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: var(--text-xs);
          font-weight: 500;
          color: var(--text-muted);
          width: 86px;
        }
        .ve-field-wide {
          width: 100%;
        }
        .ve-field input,
        .ve-field select {
          padding: var(--space-1) var(--space-2);
          font-size: var(--text-xs);
          font-weight: 400;
        }
        .ve-color {
          width: 100%;
          height: 28px;
          padding: 0;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          background: var(--bg-surface-3);
          cursor: pointer;
        }
        .ve-clip-actions {
          display: flex;
          align-items: flex-end;
          gap: var(--space-1);
          margin-left: auto;
        }
        .ve-mini-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          background: var(--bg-surface-2);
          color: var(--text-secondary);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .ve-mini-btn:hover:not(:disabled) {
          background: var(--bg-surface-3);
          color: var(--text-primary);
        }
        .ve-mini-btn:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        .ve-mini-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .ve-mini-btn.is-danger {
          color: var(--err);
        }
        .ve-mini-btn.is-danger:hover:not(:disabled) {
          background: var(--err-soft);
          border-color: var(--err);
        }
        .ve-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          padding-top: var(--space-6);
          border-top: 1px solid var(--border-subtle);
        }
        .ve-footer-info {
          font-size: var(--text-sm);
          color: var(--text-muted);
        }
        .ve-footer-hint {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          color: var(--warn);
        }
        .ve-result {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-6);
        }
        .ve-result-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-sm);
          font-weight: 500;
          color: var(--ok);
        }
        .ve-result-head :global(svg) {
          flex-shrink: 0;
        }
        .ve-result-video {
          width: 100%;
          max-height: 480px;
          border-radius: var(--radius-control);
          background: var(--bg-canvas);
        }
        .ve-result-actions {
          display: flex;
          justify-content: flex-end;
        }
        @media (max-width: 1023px) {
          .ve-main {
            grid-template-columns: 1fr;
          }
          .ve-settings {
            width: 100%;
          }
          .ve-setting {
            flex: 1;
          }
          .ve-setting select {
            min-width: 0;
            width: 100%;
          }
          .ve-tl-row {
            flex-direction: column;
            gap: var(--space-1);
          }
          .ve-tl-label {
            width: auto;
            flex-direction: row;
            align-items: center;
          }
          .ve-add-text {
            margin-top: 0;
            margin-left: var(--space-2);
          }
        }
        /* 移动端:触控目标 ≥44px,字段弹性占满,导出按钮全宽 */
        @media (max-width: 767px) {
          .ve-mobile-note {
            display: flex;
          }
          .ve-mini-btn {
            width: 44px;
            height: 44px;
          }
          .ve-field {
            width: auto;
            flex: 1 1 120px;
          }
          .ve-footer {
            flex-direction: column;
            align-items: stretch;
          }
          .ve-footer :global(.btn-lg) {
            width: 100%;
            justify-content: center;
          }
          .ve-result-actions {
            justify-content: stretch;
          }
          .ve-result-actions :global(.btn) {
            width: 100%;
            justify-content: center;
          }
        }
      `}</style>
    </div>
  );
}
