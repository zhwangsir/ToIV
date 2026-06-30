"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useActivity } from "@/components/nav/ActivityContext";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useFauxProgress } from "@/hooks/useFauxProgress";
import {
  autocutDub,
  getLipsyncLongStatus,
  imageUrl,
  startLipsyncLong,
  uploadDubVideo,
} from "@/lib/api";
import type {
  DubAutoCutResult,
  DubSegment,
  DubUploadResult,
  LipsyncLongStatus,
} from "@/lib/api";

type CutMode = "scene" | "silence";

// 切分模式默认阈值:场景=跳变灵敏度(0~1);静音=噪声门限(dB,内部取负)
const MODE_DEFAULT_THR: Record<CutMode, number> = { scene: 0.4, silence: 30 };
const POLL_MS = 3000;

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function DubStudio() {
  const [source, setSource] = useState<DubUploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 自动剪辑
  const [mode, setMode] = useState<CutMode>("scene");
  const [threshold, setThreshold] = useState(MODE_DEFAULT_THR.scene);
  const [minSeg, setMinSeg] = useState(1.5);
  const [cutting, setCutting] = useState(false);
  const [cut, setCut] = useState<DubAutoCutResult | null>(null);
  const [activeSeg, setActiveSeg] = useState<number | null>(null);

  // 分段对口型(验证)
  const [maxSegments, setMaxSegments] = useState(8);
  const [lipsExpr, setLipsExpr] = useState(1.5);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<LipsyncLongStatus | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { setActivity, clearActivity } = useActivity();
  const uploadPct = useFauxProgress(uploading, 8000);

  // 切换模式时回到该模式的默认阈值(两套量纲不同,避免误用)
  const onMode = useCallback((m: CutMode) => {
    setMode(m);
    setThreshold(MODE_DEFAULT_THR[m]);
  }, []);

  const onFile = useCallback(async (file: File) => {
    setUploading(true);
    setError(null);
    setCut(null);
    setJob(null);
    setJobId(null);
    try {
      const r = await uploadDubVideo(file);
      setSource(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }, []);

  const runAutocut = useCallback(async () => {
    if (!source || cutting) return;
    setCutting(true);
    setError(null);
    try {
      const r = await autocutDub({ name: source.name, mode, threshold, minSeg });
      setCut(r);
      setActiveSeg(null);
    } catch (e) {
      setError(`自动剪辑:${(e as Error).message}`);
    } finally {
      setCutting(false);
    }
  }, [source, cutting, mode, threshold, minSeg]);

  const seekTo = useCallback((seg: DubSegment) => {
    setActiveSeg(seg.index);
    const v = videoRef.current;
    if (v) {
      v.currentTime = seg.start;
      void v.play().catch(() => {});
    }
  }, []);

  const startLipsync = useCallback(async () => {
    if (!source || starting || job?.status === "running") return;
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const r = await startLipsyncLong({
        name: source.name,
        // 有自动剪辑片段就按其时间轴对口型,否则后端按 segSeconds 等分
        segments: cut?.segments.map((s) => ({ start: s.start, end: s.end })),
        maxSegments,
        lipsExpression: lipsExpr,
      });
      setJobId(r.job_id);
    } catch (e) {
      setError(`对口型:${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  }, [source, starting, job, cut, maxSegments, lipsExpr]);

  // 轮询对口型进度,直到终态
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await getLipsyncLongStatus(jobId);
        if (!alive) return;
        setJob(s);
        if (s.status !== "running") {
          window.clearInterval(timer);
          if (s.status === "error" && s.error) setError(`对口型:${s.error}`);
        }
      } catch {
        /* 网络抖动,下次再试 */
      }
    };
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [jobId]);

  // 把对口型态映射到灵动岛(全局可见)
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = job?.status === "running" || starting;
    if (running) {
      const pct = job && job.total > 0 ? Math.round((job.completed / job.total) * 100) : null;
      setActivity({
        kind: "video",
        label: job?.stage ?? "对口型准备中",
        value: pct,
        max: pct === null ? null : 100,
        phase: "running",
      });
      wasRunning.current = true;
    } else if (wasRunning.current) {
      wasRunning.current = false;
      setActivity({ kind: "video", label: "对口型完成", value: 100, max: 100, phase: "done" });
      const id = window.setTimeout(() => clearActivity(), 760);
      return () => window.clearTimeout(id);
    }
  }, [job, starting, setActivity, clearActivity]);

  const segs = cut?.segments ?? [];
  const totalDur = cut?.source_duration ?? 0;
  const jobPct = job && job.total > 0 ? Math.round((job.completed / job.total) * 100) : null;

  return (
    <div className="dub-studio">
      <header className="dub-head">
        <h2>
          视频译制工坊 <span className="grad">长视频 · 自动剪辑 · 对口型</span>
        </h2>
        <p className="dub-sub">
          上传已有长视频 → 智能切分得到带时间轴的片段 → 分段对口型(真人写实层效果好)。
          多语言配音将在阶段 2 接入。
        </p>
      </header>

      {error && <div className="alert dub-alert">⚠ {error}</div>}

      {!source ? (
        <div className="dub-upload">
          <label className={`dub-drop${uploading ? " busy" : ""}`}>
            <input
              type="file"
              accept=".mp4,.mov,.webm,.mkv"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
            />
            <span className="dub-drop-icon" aria-hidden="true">
              ▶
            </span>
            <span className="dub-drop-title">{uploading ? "上传中…" : "上传长视频"}</span>
            <span className="dub-drop-hint">MP4 / MOV / WEBM / MKV,≤ 600MB,拖入或点击</span>
          </label>
          {uploading && (
            <ProgressBar
              active
              value={uploadPct}
              tone="cool"
              label="上传中…(大文件流式落盘)"
              className="dub-upload-progress"
            />
          )}
        </div>
      ) : (
        <div className="dub-work">
          <aside className="dub-source">
            <video
              ref={videoRef}
              className="dub-video"
              src={imageUrl(source.url)}
              controls
              preload="metadata"
            />
            <div className="dub-source-meta">
              {(source.size / 1024 / 1024).toFixed(1)} MB
              {totalDur > 0 ? ` · ${fmt(totalDur)}` : ""}
            </div>
            <button
              type="button"
              className="manju-ghost-btn"
              onClick={() => {
                setSource(null);
                setCut(null);
                setJob(null);
                setJobId(null);
              }}
            >
              ↻ 换视频
            </button>
          </aside>

          <div className="dub-main">
            {/* —— 自动剪辑 —— */}
            <section className="dub-panel">
              <div className="dub-panel-head">
                <h3>① 自动剪辑</h3>
                <span className="dub-panel-hint">场景跳变 / 静音停顿切句</span>
              </div>
              <div className="dub-controls">
                <div className="dub-modes">
                  <button
                    type="button"
                    className={mode === "scene" ? "active" : ""}
                    onClick={() => onMode("scene")}
                  >
                    场景切
                  </button>
                  <button
                    type="button"
                    className={mode === "silence" ? "active" : ""}
                    onClick={() => onMode("silence")}
                  >
                    静音切句
                  </button>
                </div>
                <div className="field dub-slider">
                  <label>
                    {mode === "scene" ? "跳变灵敏度" : "静音门限"}
                    <span className="dub-val">
                      {mode === "scene" ? threshold.toFixed(2) : `-${threshold}dB`}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={mode === "scene" ? 0.1 : 20}
                    max={mode === "scene" ? 0.9 : 50}
                    step={mode === "scene" ? 0.05 : 1}
                    value={threshold}
                    onChange={(e) => setThreshold(parseFloat(e.target.value))}
                  />
                </div>
                <div className="field dub-slider">
                  <label>
                    最短片段<span className="dub-val">{minSeg.toFixed(1)}s</span>
                  </label>
                  <input
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.5}
                    value={minSeg}
                    onChange={(e) => setMinSeg(parseFloat(e.target.value))}
                  />
                </div>
                <button
                  type="button"
                  className="dub-run-btn"
                  disabled={cutting}
                  onClick={() => void runAutocut()}
                >
                  {cutting ? "切分中…" : "✂ 自动剪辑"}
                </button>
              </div>

              {cut && (
                <div className="dub-segments">
                  <div className="dub-seg-summary">
                    切出 <strong>{cut.count}</strong> 段 · 共 {fmt(cut.source_duration)} ·{" "}
                    {cut.mode === "silence" ? "静音切句" : "场景切"}
                  </div>
                  {segs.length > 0 && (
                    <div className="dub-timeline" role="list">
                      {segs.map((s) => (
                        <button
                          key={s.index}
                          type="button"
                          role="listitem"
                          className={`dub-seg${activeSeg === s.index ? " active" : ""}`}
                          style={{ flexGrow: Math.max(s.duration, 0.2) }}
                          title={`#${s.index + 1} ${fmt(s.start)}–${fmt(s.end)} (${s.duration.toFixed(1)}s)`}
                          onClick={() => seekTo(s)}
                        >
                          <span className="dub-seg-idx">{s.index + 1}</span>
                          <span className="dub-seg-dur">{s.duration.toFixed(1)}s</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="dub-seg-tip">点击片段可在上方预览跳转到该时间点</p>
                </div>
              )}
            </section>

            {/* —— 分段对口型 —— */}
            <section className="dub-panel">
              <div className="dub-panel-head">
                <h3>② 分段对口型</h3>
                <span className="dub-panel-hint">
                  真人单语言验证 · 量「对口型质量 + GPU 成本」
                </span>
              </div>
              <div className="dub-controls">
                <div className="field dub-slider">
                  <label>
                    本次跑段数<span className="dub-val">{maxSegments}</span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, Math.min(20, segs.length || 20))}
                    step={1}
                    value={maxSegments}
                    onChange={(e) => setMaxSegments(parseInt(e.target.value, 10))}
                  />
                </div>
                <div className="field dub-slider">
                  <label>
                    口型幅度<span className="dub-val">{lipsExpr.toFixed(1)}</span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={3}
                    step={0.1}
                    value={lipsExpr}
                    onChange={(e) => setLipsExpr(parseFloat(e.target.value))}
                  />
                </div>
                <button
                  type="button"
                  className="dub-run-btn primary"
                  disabled={starting || job?.status === "running"}
                  onClick={() => void startLipsync()}
                >
                  {starting || job?.status === "running" ? "对口型中…" : "👄 分段对口型(验证)"}
                </button>
              </div>
              <p className="dub-seg-tip">
                未先剪辑则按 12s 等分整片;单段无人脸会自动回退原片段,不中断整条作业。
              </p>

              {(job?.status === "running" || starting) && (
                <ProgressBar
                  active
                  tone="voice"
                  value={jobPct}
                  label={job?.stage ?? "准备中…"}
                  className="dub-run-progress"
                />
              )}

              {job && (
                <div className="dub-job-stats">
                  <div className="dub-stat">
                    <span className="dub-stat-k">进度</span>
                    <span className="dub-stat-v">
                      {job.completed}/{job.total} 段
                    </span>
                  </div>
                  <div className="dub-stat">
                    <span className="dub-stat-k">GPU 用时</span>
                    <span className="dub-stat-v">{job.gpu_seconds.toFixed(0)}s</span>
                  </div>
                  <div className="dub-stat">
                    <span className="dub-stat-k">总耗时</span>
                    <span className="dub-stat-v">{job.elapsed.toFixed(0)}s</span>
                  </div>
                  {job.fallbacks > 0 && (
                    <div className="dub-stat warn">
                      <span className="dub-stat-k">回退段</span>
                      <span className="dub-stat-v">{job.fallbacks}</span>
                    </div>
                  )}
                </div>
              )}

              {job?.status === "done" && job.url && (
                <div className="dub-result">
                  <video className="dub-video" src={imageUrl(job.url)} controls />
                  <a
                    className="dub-run-btn"
                    href={imageUrl(job.url)}
                    download
                    target="_blank"
                    rel="noreferrer"
                  >
                    ⤓ 下载成片
                  </a>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
