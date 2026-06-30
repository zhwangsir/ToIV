"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useActivity } from "@/components/nav/ActivityContext";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useFauxProgress } from "@/hooks/useFauxProgress";
import {
  autocutDub,
  getLipsyncLongStatus,
  imageUrl,
  importSrtDub,
  startLipsyncLong,
  transcribeDub,
  translateDub,
  uploadDubVideo,
  voiceTrackDub,
} from "@/lib/api";
import type {
  DubAutoCutResult,
  DubSegment,
  DubTextSegment,
  DubUploadResult,
  LipsyncLongStatus,
  VoiceTrackResult,
} from "@/lib/api";

type CutMode = "scene" | "silence";
type TargetLang = "zh" | "en";
type DubRow = DubTextSegment & { translated?: string };

// 切分模式默认阈值:场景=跳变灵敏度(0~1);静音=噪声门限(dB,内部取负)
const MODE_DEFAULT_THR: Record<CutMode, number> = { scene: 0.4, silence: 30 };
const LANG_LABEL: Record<TargetLang, string> = { zh: "中文", en: "英语" };
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

  // ① 自动剪辑
  const [mode, setMode] = useState<CutMode>("scene");
  const [threshold, setThreshold] = useState(MODE_DEFAULT_THR.scene);
  const [minSeg, setMinSeg] = useState(1.5);
  const [cutting, setCutting] = useState(false);
  const [cut, setCut] = useState<DubAutoCutResult | null>(null);
  const [activeSeg, setActiveSeg] = useState<number | null>(null);

  // ② 听写 · 翻译 · 配音
  const [rows, setRows] = useState<DubRow[]>([]);
  const [targetLang, setTargetLang] = useState<TargetLang>("zh");
  const [importing, setImporting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [makingTrack, setMakingTrack] = useState(false);
  const [track, setTrack] = useState<VoiceTrackResult | null>(null);

  // ③ 分段对口型
  const [maxSegments, setMaxSegments] = useState(8);
  const [lipsExpr, setLipsExpr] = useState(1.5);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<LipsyncLongStatus | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { setActivity, clearActivity } = useActivity();
  const uploadPct = useFauxProgress(uploading, 8000);

  const resetDerived = useCallback(() => {
    setCut(null);
    setRows([]);
    setTrack(null);
    setJob(null);
    setJobId(null);
  }, []);

  const onMode = useCallback((m: CutMode) => {
    setMode(m);
    setThreshold(MODE_DEFAULT_THR[m]);
  }, []);

  const onFile = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      resetDerived();
      try {
        const r = await uploadDubVideo(file);
        setSource(r);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [resetDerived],
  );

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

  const seekTo = useCallback((start: number, idx: number) => {
    setActiveSeg(idx);
    const v = videoRef.current;
    if (v) {
      v.currentTime = start;
      void v.play().catch(() => {});
    }
  }, []);

  // —— ② 听写翻译配音 ——
  const onSrt = useCallback(async (file: File) => {
    setImporting(true);
    setError(null);
    setTrack(null);
    try {
      const r = await importSrtDub(file);
      setRows(r.segments.map((s) => ({ ...s })));
    } catch (e) {
      setError(`字幕导入:${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  }, []);

  const runTranscribe = useCallback(async () => {
    if (!source || transcribing) return;
    setTranscribing(true);
    setError(null);
    setTrack(null);
    try {
      const r = await transcribeDub(source.name);
      setRows(r.segments.map((s) => ({ ...s })));
    } catch (e) {
      setError(`听写:${(e as Error).message}`);
    } finally {
      setTranscribing(false);
    }
  }, [source, transcribing]);

  const runTranslate = useCallback(async () => {
    if (!rows.length || translating) return;
    setTranslating(true);
    setError(null);
    try {
      const r = await translateDub(
        rows.map((s) => ({ index: s.index, text: s.text })),
        targetLang,
      );
      const map = new Map(r.translated.map((t) => [t.index, t.translated]));
      setRows((prev) => prev.map((s) => ({ ...s, translated: map.get(s.index) ?? s.translated })));
    } catch (e) {
      setError(`翻译:${(e as Error).message}`);
    } finally {
      setTranslating(false);
    }
  }, [rows, translating, targetLang]);

  const editRow = useCallback((index: number, value: string) => {
    setRows((prev) => prev.map((s) => (s.index === index ? { ...s, translated: value } : s)));
  }, []);

  const makeTrack = useCallback(async () => {
    if (!source || !rows.length || makingTrack) return;
    setMakingTrack(true);
    setError(null);
    try {
      const r = await voiceTrackDub({
        name: source.name,
        // 有译文用译文,否则用原文(原片已是目标语时)
        segments: rows.map((s) => ({ start: s.start, end: s.end, text: s.translated || s.text })),
      });
      setTrack(r);
    } catch (e) {
      setError(`配音轨:${(e as Error).message}`);
    } finally {
      setMakingTrack(false);
    }
  }, [source, rows, makingTrack]);

  // —— ③ 分段对口型 ——
  const startLipsync = useCallback(async () => {
    if (!source || starting || job?.status === "running") return;
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      // 优先级:有配音轨→按译制片段切并用配音轨;否则→自动剪辑片段;否则→后端等分
      const segSource =
        track && rows.length
          ? rows.map((s) => ({ start: s.start, end: s.end }))
          : cut?.segments.map((s) => ({ start: s.start, end: s.end }));
      const r = await startLipsyncLong({
        name: source.name,
        segments: segSource,
        maxSegments,
        lipsExpression: lipsExpr,
        audioName: track?.name,
      });
      setJobId(r.job_id);
    } catch (e) {
      setError(`对口型:${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  }, [source, starting, job, track, rows, cut, maxSegments, lipsExpr]);

  // 轮询对口型进度
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

  // 灵动岛活动映射
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
  const translatedCount = rows.filter((s) => s.translated?.trim()).length;

  return (
    <div className="dub-studio">
      <header className="dub-head">
        <h2>
          视频译制工坊 <span className="grad">剪辑 · 听写翻译 · 配音 · 对口型</span>
        </h2>
        <p className="dub-sub">
          上传长视频 → 自动剪辑 → 导入字幕/听写得台本 → 翻译并克隆原音色配音 → 分段对口型成片。
          中英已通;日韩待阶段 3。
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
                resetDerived();
              }}
            >
              ↻ 换视频
            </button>
          </aside>

          <div className="dub-main">
            {/* —— ① 自动剪辑 —— */}
            <section className="dub-panel">
              <div className="dub-panel-head">
                <h3>① 自动剪辑</h3>
                <span className="dub-panel-hint">场景跳变 / 静音停顿切句(无字幕时给对口型分段)</span>
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
                <button type="button" className="dub-run-btn" disabled={cutting} onClick={() => void runAutocut()}>
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
                      {segs.map((s: DubSegment) => (
                        <button
                          key={s.index}
                          type="button"
                          role="listitem"
                          className={`dub-seg${activeSeg === s.index ? " active" : ""}`}
                          style={{ flexGrow: Math.max(s.duration, 0.2) }}
                          title={`#${s.index + 1} ${fmt(s.start)}–${fmt(s.end)} (${s.duration.toFixed(1)}s)`}
                          onClick={() => seekTo(s.start, s.index)}
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

            {/* —— ② 听写 · 翻译 · 配音 —— */}
            <section className="dub-panel">
              <div className="dub-panel-head">
                <h3>② 听写 · 翻译 · 配音</h3>
                <span className="dub-panel-hint">导入字幕或听写 → 翻译 → 克隆原音色配音轨</span>
              </div>
              <div className="dub-controls">
                <label className="dub-run-btn dub-srt-label">
                  <input
                    type="file"
                    accept=".srt,.vtt"
                    style={{ display: "none" }}
                    disabled={importing}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onSrt(f);
                      e.target.value = "";
                    }}
                  />
                  {importing ? "导入中…" : "📄 导入字幕(SRT/VTT)"}
                </label>
                <button
                  type="button"
                  className="dub-run-btn"
                  disabled={transcribing}
                  onClick={() => void runTranscribe()}
                >
                  {transcribing ? "听写中…" : "🎧 听写(Whisper)"}
                </button>
                <div className="dub-modes">
                  {(["zh", "en"] as TargetLang[]).map((l) => (
                    <button
                      key={l}
                      type="button"
                      className={targetLang === l ? "active" : ""}
                      onClick={() => setTargetLang(l)}
                    >
                      译成{LANG_LABEL[l]}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="dub-run-btn"
                  disabled={translating || !rows.length}
                  onClick={() => void runTranslate()}
                >
                  {translating ? "翻译中…" : "🌐 翻译"}
                </button>
                <button
                  type="button"
                  className="dub-run-btn primary"
                  disabled={makingTrack || !rows.length}
                  onClick={() => void makeTrack()}
                >
                  {makingTrack ? "合成配音中…" : "🎙 生成配音轨"}
                </button>
              </div>

              {rows.length > 0 && (
                <div className="dub-table-wrap">
                  <div className="dub-table-meta">
                    {rows.length} 句 · 已译 {translatedCount}
                  </div>
                  <div className="dub-table">
                    {rows.map((s) => (
                      <div key={s.index} className="dub-trow">
                        <button
                          type="button"
                          className="dub-trow-time"
                          title="跳转到此句"
                          onClick={() => seekTo(s.start, s.index)}
                        >
                          {fmt(s.start)}
                        </button>
                        <div className="dub-trow-src" title={s.text}>
                          {s.text}
                        </div>
                        <textarea
                          className="dub-trow-dst"
                          rows={1}
                          placeholder="译文…"
                          value={s.translated ?? ""}
                          onChange={(e) => editRow(s.index, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {track && (
                <div className="dub-track">
                  <span className="dub-track-ok">✓ 配音轨已就绪 · {track.segment_count} 段 · {fmt(track.duration)}</span>
                  <audio className="dub-audio" src={imageUrl(track.url)} controls />
                </div>
              )}
            </section>

            {/* —— ③ 分段对口型 —— */}
            <section className="dub-panel">
              <div className="dub-panel-head">
                <h3>③ 分段对口型成片</h3>
                <span className="dub-panel-hint">
                  {track ? "用配音轨 → 译制成片" : "用源音轨 → 验证质量 + GPU 成本"}
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
                    max={Math.max(1, Math.min(20, (track ? rows.length : segs.length) || 20))}
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
                  {starting || job?.status === "running" ? "对口型中…" : "👄 分段对口型"}
                </button>
              </div>
              <p className="dub-seg-tip">
                {track
                  ? "将按译制片段切片,用配音轨逐段对口型 → 输出译制版。"
                  : "未生成配音轨则用源视频自带音轨(单语言验证);单段无人脸自动回退原片段。"}
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
                  <a className="dub-run-btn" href={imageUrl(job.url)} download target="_blank" rel="noreferrer">
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
