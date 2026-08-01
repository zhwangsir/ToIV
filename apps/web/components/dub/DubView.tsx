"use client";

import { useCallback, useRef, useState } from "react";

import {
  autocutDub,
  getAnimeLipsyncStatus,
  getLipsyncLongStatus,
  highlightsDub,
  importSrtDub,
  imageUrl,
  startAnimeLipsync,
  startLipsyncLong,
  transcribeDub,
  translateDub,
  uploadDubVideo,
  voiceTrackDub,
  type AnimeLipsyncStatus,
  type DubTextSegment,
  type DubUploadResult,
  type LipsyncLongStart,
  type LipsyncLongStatus,
  type VoiceTrackResult,
} from "@/lib/api";
import { Icon, type IconName } from "@/components/ui/Icon";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { useToast } from "@/components/ui/Toast";
import { usePoll } from "@/hooks/usePoll";

// ── 步骤元数据 ──────────────────────────────────────────────
interface StepMeta {
  n: number;
  label: string;
  hint: string;
  icon: IconName;
}
const STEPS: StepMeta[] = [
  { n: 1, label: "上传视频", hint: "拖入源文件", icon: "upload" },
  { n: 2, label: "听写字幕", hint: "Whisper / SRT", icon: "file" },
  { n: 3, label: "配音生成", hint: "克隆音色合成", icon: "audio" },
  { n: 4, label: "口型同步", hint: "LatentSync 对口型", icon: "video" },
];

// ── 工具:格式化秒 → mm:ss ──
function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── 默认参数(集中管理 magic numbers) ──────────────────────
const DEFAULT_DUB_PARAMS = {
  refSeconds: 8,
  segSeconds: 12,
  threshold: 0.3,
  minSeg: 3,
  maxSegments: 8,
  lipsExpression: 1.5,
  inferenceSteps: 20,
  mouthGain: 1.0,
  smooth: 3,
  highlightsTarget: 0,
};

// 对口型状态轮询:2s 基准;连续失败超过该次数停止并提示(此前由 usePoll backoff 容错)
const POLL_MAX_FAILURES = 10;

// 上传校验:后端译制上传为流式分块无显式上限,客户端给 200MB;类型白名单
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
const VIDEO_EXT_OK = ["mp4", "mov", "webm", "mkv", "avi", "m4v"];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

// ── 主组件 ──────────────────────────────────────────────────

/** 对口型模式:LatentSync 长视频 / 动漫对口型 / AI 精剪。 */
type LipsyncMode = "latent" | "anime" | "highlights";

export function DubView() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // ── Step 1: 上传 ──
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [video, setVideo] = useState<DubUploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ── Step 2: 字幕 ──
  const [segments, setSegments] = useState<DubTextSegment[]>([]);
  const [subBusy, setSubBusy] = useState(false);
  const [subStage, setSubStage] = useState("");
  const [subPct, setSubPct] = useState(0);
  const [subError, setSubError] = useState<string | null>(null);
  // 翻译
  const [targetLang, setTargetLang] = useState("zh");
  const [translated, setTranslated] = useState<Record<number, string>>({});
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);

  // ── Step 3: 配音 ──
  const [refSeconds, setRefSeconds] = useState(DEFAULT_DUB_PARAMS.refSeconds);
  const [emoText, setEmoText] = useState("");
  const [voice, setVoice] = useState<VoiceTrackResult | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceStage, setVoiceStage] = useState("");
  const [voicePct, setVoicePct] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // ── Step 4: 对口型 ──
  const [cutMode, setCutMode] = useState<"even" | "scene" | "silence">("even");
  const [segSeconds, setSegSeconds] = useState(DEFAULT_DUB_PARAMS.segSeconds);
  const [threshold, setThreshold] = useState(DEFAULT_DUB_PARAMS.threshold);
  const [minSeg, setMinSeg] = useState(DEFAULT_DUB_PARAMS.minSeg);
  const [maxSegments, setMaxSegments] = useState(DEFAULT_DUB_PARAMS.maxSegments);
  const [lipsExpression, setLipsExpression] = useState(DEFAULT_DUB_PARAMS.lipsExpression);
  const [inferenceSteps, setInferenceSteps] = useState(DEFAULT_DUB_PARAMS.inferenceSteps);
  const [useDubVoice, setUseDubVoice] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lipsyncStart, setLipsyncStart] = useState<LipsyncLongStart | null>(null);
  const [lipsyncStatus, setLipsyncStatus] = useState<LipsyncLongStatus | null>(null);
  const [lipsyncBusy, setLipsyncBusy] = useState(false);
  const [lipsyncError, setLipsyncError] = useState<string | null>(null);
  const pollFailRef = useRef(0);
  const { show: showToast } = useToast();

  // 对口型模式选择 + 动漫 / 精剪分支状态
  const [lipsyncMode, setLipsyncMode] = useState<LipsyncMode>("latent");
  // 动漫对口型
  const [animeStart, setAnimeStart] = useState<{ job_id: string } | null>(null);
  const [animeStatus, setAnimeStatus] = useState<AnimeLipsyncStatus | null>(null);
  const [mouthGain, setMouthGain] = useState(DEFAULT_DUB_PARAMS.mouthGain);
  const [smooth, setSmooth] = useState(DEFAULT_DUB_PARAMS.smooth);
  // AI 精剪
  const [highlightsResult, setHighlightsResult] = useState<{
    title: string;
    selected: number[];
    count: number;
  } | null>(null);
  const [highlightsTarget, setHighlightsTarget] = useState(DEFAULT_DUB_PARAMS.highlightsTarget);

  // ── Step 1: 上传 ──
  const onPick = useCallback((f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/") || !VIDEO_EXT_OK.includes(fileExt(f.name))) {
      setUploadError(`「${f.name}」格式不支持(仅 mp4/mov/webm/mkv/avi)`);
      return;
    }
    if (f.size > VIDEO_MAX_BYTES) {
      setUploadError(`「${f.name}」超过 200MB 上限(${fmtBytes(f.size)})`);
      return;
    }
    setFile(f);
    setUploadError(null);
    setVideo(null);
    setUploadPct(0);
  }, []);

  const doUpload = useCallback(async () => {
    if (!file) return;
    setUploading(true);
    setUploadPct(0);
    setUploadError(null);
    try {
      const r = await uploadDubVideo(file, (p) => setUploadPct(p));
      setVideo(r);
      setUploadPct(100);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }, [file]);

  // ── Step 2: 听写 / SRT 导入 ──
  const onPickSrt = useCallback(async (f: File | null) => {
    if (!f || !video) return;
    setSubBusy(true);
    setSubStage("解析字幕");
    setSubPct(10);
    setSubError(null);
    try {
      const r = await importSrtDub(f);
      setSegments(r.segments);
      setSubPct(100);
    } catch (e) {
      setSubError(e instanceof Error ? e.message : "字幕导入失败");
    } finally {
      setSubBusy(false);
    }
  }, [video]);

  const doTranscribe = useCallback(async () => {
    if (!video) return;
    setSubBusy(true);
    setSubStage("启动 Whisper");
    setSubPct(0);
    setSubError(null);
    setSegments([]);
    setTranslated({});
    try {
      const r = await transcribeDub(video.name, (p) => {
        setSubStage(p.stage || "听写中");
        setSubPct(p.progress ?? 0);
      });
      setSegments(r.segments);
      setSubPct(100);
    } catch (e) {
      setSubError(e instanceof Error ? e.message : "听写失败");
    } finally {
      setSubBusy(false);
    }
  }, [video]);

  const doTranslate = useCallback(async () => {
    if (segments.length === 0) return;
    setTranslating(true);
    setTranslateError(null);
    try {
      const r = await translateDub(
        segments.map((s) => ({ index: s.index, text: s.text })),
        targetLang,
      );
      const map: Record<number, string> = {};
      for (const t of r.translated) map[t.index] = t.translated;
      setTranslated(map);
    } catch (e) {
      setTranslateError(e instanceof Error ? e.message : "翻译失败");
    } finally {
      setTranslating(false);
    }
  }, [segments, targetLang]);

  // ── Step 3: 配音 ──
  const doVoice = useCallback(async () => {
    if (!video || segments.length === 0) return;
    setVoiceBusy(true);
    setVoiceStage("启动配音");
    setVoicePct(0);
    setVoiceError(null);
    setVoice(null);
    // 优先用译文,无译文的段落回落到原文
    const segs = segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: translated[s.index] ?? s.text,
    }));
    try {
      const r = await voiceTrackDub(
        { name: video.name, segments: segs, refSeconds, emoText: emoText || undefined },
        (p) => {
          setVoiceStage(p.stage || "合成中");
          setVoicePct(p.progress ?? 0);
        },
      );
      setVoice(r);
      setVoicePct(100);
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "配音失败");
    } finally {
      setVoiceBusy(false);
    }
  }, [video, segments, translated, refSeconds, emoText]);

  // ── Step 4: 对口型 ──
  const doLipsync = useCallback(async () => {
    if (!video) return;

    // AI 精剪:同步调用,无需轮询
    if (lipsyncMode === "highlights") {
      if (segments.length === 0) {
        setLipsyncError("AI 精剪需要字幕,请先在步骤 2 生成或导入字幕");
        return;
      }
      setLipsyncBusy(true);
      setLipsyncError(null);
      setHighlightsResult(null);
      try {
        const r = await highlightsDub(
          segments.map((s) => ({ index: s.index, text: s.text })),
          highlightsTarget,
        );
        setHighlightsResult(r);
      } catch (e) {
        setLipsyncError(e instanceof Error ? e.message : "AI 精剪失败");
      } finally {
        setLipsyncBusy(false);
      }
      return;
    }

    // LatentSync / 动漫对口型:启动后台作业 + 轮询
    setLipsyncBusy(true);
    setLipsyncError(null);
    setLipsyncStatus(null);
    setLipsyncStart(null);
    setAnimeStatus(null);
    setAnimeStart(null);
    try {
      if (lipsyncMode === "anime") {
        // 动漫对口型(本地 CV,非 LatentSync)
        const r = await startAnimeLipsync({
          name: video.name,
          audioName: useDubVoice && voice ? voice.name : undefined,
          mouthGain,
          smooth,
        });
        setAnimeStart(r);
        pollFailRef.current = 0;
      } else {
        // LatentSync 长视频对口型
        let segs: { start: number; end: number }[] | undefined;
        if (cutMode !== "even") {
          const ac = await autocutDub({
            name: video.name,
            mode: cutMode,
            threshold,
            minSeg,
          });
          segs = ac.segments.map((s) => ({ start: s.start, end: s.end }));
        }
        const r = await startLipsyncLong({
          name: video.name,
          segments: segs,
          segSeconds: cutMode === "even" ? segSeconds : undefined,
          maxSegments,
          lipsExpression,
          inferenceSteps,
          audioName: useDubVoice && voice ? voice.name : undefined,
        });
        setLipsyncStart(r);
        pollFailRef.current = 0;
      }
    } catch (e) {
      setLipsyncError(e instanceof Error ? e.message : "启动对口型失败");
      setLipsyncBusy(false);
    }
  }, [video, lipsyncMode, segments, highlightsTarget, useDubVoice, voice, mouthGain, smooth, cutMode, threshold, minSeg, segSeconds, maxSegments, lipsExpression, inferenceSteps]);

  // 轮询对口型状态(LatentSync + 动漫对口型共用)
  // usePoll:页面隐藏自动暂停;单次网络错误指数退避(×1.5,上限 30s)容错;
  // 连续失败超过 POLL_MAX_FAILURES 次则停止并 toast 提示,不再无限轮询宕机后端。
  const lipsyncPolling =
    lipsyncBusy &&
    ((lipsyncMode === "latent" && !!lipsyncStart) ||
      (lipsyncMode === "anime" && !!animeStart));
  usePoll(
    async () => {
      try {
        if (lipsyncMode === "latent" && lipsyncStart) {
          const s = await getLipsyncLongStatus(lipsyncStart.job_id);
          pollFailRef.current = 0;
          setLipsyncStatus(s);
          if (s.status === "done" || s.status === "error") {
            setLipsyncBusy(false);
            if (s.status === "error") {
              setLipsyncError(s.error ?? "对口型失败");
            }
          }
        } else if (lipsyncMode === "anime" && animeStart) {
          const s = await getAnimeLipsyncStatus(animeStart.job_id);
          pollFailRef.current = 0;
          setAnimeStatus(s);
          if (s.status === "done" || s.status === "error") {
            setLipsyncBusy(false);
            if (s.status === "error") {
              setLipsyncError(s.error ?? "动漫对口型失败");
            }
          }
        }
      } catch (e) {
        pollFailRef.current += 1;
        if (pollFailRef.current > POLL_MAX_FAILURES) {
          setLipsyncBusy(false);
          setLipsyncError("连续多次查询状态失败,已停止轮询;请确认后端在线后重试");
          showToast("error", "对口型状态查询连续失败,已停止轮询");
          return;
        }
        throw e; // 交给 usePoll 退避重试
      }
    },
    { intervalMs: 2000, enabled: lipsyncPolling, backoff: true },
  );

  // ── 步骤可达性 ──
  const canStep2 = !!video;
  const canStep3 = !!video && segments.length > 0;
  const canStep4 = !!video;

  const goStep = (n: 1 | 2 | 3 | 4) => {
    if (n === 1) setStep(1);
    else if (n === 2 && canStep2) setStep(2);
    else if (n === 3 && canStep3) setStep(3);
    else if (n === 4 && canStep4) setStep(4);
  };

  // ── 渲染 ──
  return (
    <div className="single-view dub-view">
      {/* 顶部标题 */}
      <header className="dub-header">
        <div className="dub-titles">
          <h1 className="dub-title">译制</h1>
          <p className="dub-subtitle">
            视频译制 · 听写 · 翻译 · 配音 · 口型同步
          </p>
        </div>
        <div className="dub-meta">
          {video && (
            <span className="badge badge-accent" title={video.url}>
              <Icon name="video" size={12} strokeWidth={2} />
              {video.name}
            </span>
          )}
          {voice && (
            <span className="badge" title={voice.url}>
              <Icon name="audio" size={12} strokeWidth={2} />
              配音轨 · {voice.segment_count} 段
            </span>
          )}
        </div>
      </header>

      {/* 步骤指示器 */}
      <nav className="dub-stepper" aria-label="译制步骤">
        {STEPS.map((s, i) => {
          const done =
            (s.n === 1 && !!video) ||
            (s.n === 2 && segments.length > 0) ||
            (s.n === 3 && !!voice) ||
            (s.n === 4 &&
              ((lipsyncMode === "latent" &&
                !!lipsyncStatus &&
                lipsyncStatus.status === "done") ||
                (lipsyncMode === "anime" &&
                  !!animeStatus &&
                  animeStatus.status === "done") ||
                (lipsyncMode === "highlights" && !!highlightsResult)));
          const active = step === s.n;
          const reachable =
            s.n === 1 ||
            (s.n === 2 && canStep2) ||
            (s.n === 3 && canStep3) ||
            (s.n === 4 && canStep4);
          return (
            <div
              key={s.n}
              className={`dub-step${active ? " is-active" : ""}${done ? " is-done" : ""}${!reachable && !active ? " is-locked" : ""}`}
              onClick={() => reachable && goStep(s.n as 1 | 2 | 3 | 4)}
              role="button"
              tabIndex={reachable ? 0 : -1}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && reachable) {
                  e.preventDefault();
                  goStep(s.n as 1 | 2 | 3 | 4);
                }
              }}
            >
              <div className="dub-step-circle">
                {done ? (
                  <Icon name="success" size={14} strokeWidth={2.4} />
                ) : (
                  <span>{s.n}</span>
                )}
              </div>
              <div className="dub-step-text">
                <div className="dub-step-label">{s.label}</div>
                <div className="dub-step-hint">{s.hint}</div>
              </div>
              {i < STEPS.length - 1 && <div className="dub-step-line" />}
            </div>
          );
        })}
      </nav>

      {/* 步骤内容 */}
      <div className="dub-stage">
        {/* ── Step 1: 上传 ── */}
        {step === 1 && (
          <section className="card dub-panel">
            <div className="dub-panel-head">
              <h2>上传源视频</h2>
              <p>支持 mp4 / mov / mkv,长视频可自动分段对口型</p>
            </div>

            {!file && !video && (
              <label
                className={`dub-dropzone${dragging ? " is-drag" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) onPick(f);
                }}
              >
                <input
                  type="file"
                  accept="video/*"
                  hidden
                  onChange={(e) => onPick(e.target.files?.[0] ?? null)}
                />
                <div className="dub-dropzone-inner">
                  <Icon name="upload" size={36} strokeWidth={1.4} />
                  <div className="dub-dropzone-title">拖拽视频到此处</div>
                  <div className="dub-dropzone-sub">或点击选择文件</div>
                  <span className="btn btn-sm dub-dropzone-btn">选择文件</span>
                </div>
              </label>
            )}

            {file && !video && (
              <div className="dub-file-card">
                <div className="dub-file-icon">
                  <Icon name="video" size={22} strokeWidth={1.6} />
                </div>
                <div className="dub-file-info">
                  <div className="dub-file-name">{file.name}</div>
                  <div className="dub-file-meta">
                    {fmtBytes(file.size)} · {file.type || "video"}
                  </div>
                </div>
                <div className="dub-file-actions">
                  {!uploading && (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={doUpload}>
                        <Icon name="upload" size={14} strokeWidth={2} />
                        开始上传
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => onPick(null)}>
                        <Icon name="close" size={14} strokeWidth={2} />
                        重选
                      </button>
                    </>
                  )}
                </div>
                {uploading && (
                  <div className="dub-progress">
                    <div className="dub-progress-bar" style={{ width: `${uploadPct}%` }} />
                    <span className="dub-progress-label">{uploadPct}%</span>
                  </div>
                )}
              </div>
            )}

            {uploadError && (
              <div className="dub-error">
                <Icon name="error" size={14} strokeWidth={2} />
                {uploadError}
              </div>
            )}

            {video && (
              <div className="dub-video-result">
                <div className="dub-video-frame">
                  <video src={imageUrl(video.url)} controls preload="metadata" />
                </div>
                <div className="dub-video-summary">
                  <div className="dub-video-name">
                    <Icon name="video" size={14} strokeWidth={2} />
                    <span>{video.name}</span>
                  </div>
                  <div className="dub-video-stats">
                    <span className="badge badge-success">
                      <Icon name="success" size={11} strokeWidth={2.4} />
                      已上传
                    </span>
                    <span className="badge">{fmtBytes(video.size)}</span>
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep(2)}
                  >
                    下一步 · 听写字幕
                    <Icon name="send" size={14} strokeWidth={2} />
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── Step 2: 听写 / 翻译 ── */}
        {step === 2 && (
          <section className="card dub-panel">
            <div className="dub-panel-head">
              <h2>生成字幕</h2>
              <p>Whisper 自动听写,或导入 SRT/VTT 字幕文件</p>
            </div>

            <div className="dub-actions-row">
              <button
                className="btn btn-primary"
                onClick={doTranscribe}
                disabled={subBusy}
              >
                <Icon name={subBusy ? "loading" : "file"} size={14} strokeWidth={2} />
                {subBusy ? "听写中…" : "Whisper 听写"}
              </button>
              <span className="dub-or">或</span>
              <label className="btn">
                <Icon name="upload" size={14} strokeWidth={2} />
                导入 SRT / VTT
                <input
                  type="file"
                  accept=".srt,.vtt,.ssa,.ass"
                  hidden
                  onChange={(e) => onPickSrt(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>

            {subBusy && (
              <div className="dub-progress">
                <div className="dub-progress-bar" style={{ width: `${subPct}%` }} />
                <span className="dub-progress-label">
                  {subStage} · {subPct}%
                </span>
              </div>
            )}
            {subError && (
              <div className="dub-error">
                <Icon name="error" size={14} strokeWidth={2} />
                {subError}
              </div>
            )}

            {/* 空态:暂无字幕分段 */}
            {segments.length === 0 && !subBusy && (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <Icon name="audio" size={56} strokeWidth={1.1} />
                </div>
                <div className="empty-state-title">暂无字幕分段</div>
                <div className="empty-state-desc">
                  请先使用 Whisper 听写,或导入 SRT / VTT 字幕
                </div>
              </div>
            )}

            {segments.length > 0 && (
              <>
                <div className="dub-subtoolbar">
                  <span className="badge badge-accent">
                    {segments.length} 条字幕
                  </span>
                  <div className="dub-translate">
                    <select
                      className="input dub-translate-select"
                      value={targetLang}
                      onChange={(e) => setTargetLang(e.target.value)}
                    >
                      <option value="zh">译为 中文</option>
                      <option value="en">译为 English</option>
                      <option value="ja">译为 日本語</option>
                      <option value="ko">译为 한국어</option>
                      <option value="fr">译为 Français</option>
                      <option value="es">译为 Español</option>
                    </select>
                    <button
                      className="btn"
                      onClick={doTranslate}
                      disabled={translating}
                    >
                      <Icon name={translating ? "loading" : "send"} size={14} strokeWidth={2} />
                      {translating ? "翻译中…" : "翻译"}
                    </button>
                  </div>
                </div>
                {translateError && (
                  <div className="dub-error">
                    <Icon name="error" size={14} strokeWidth={2} />
                    {translateError}
                  </div>
                )}
                <ul className="dub-segments">
                  {segments.slice(0, 60).map((seg) => (
                    <li key={seg.index} className="dub-seg">
                      <div className="dub-seg-time">
                        <span className="dub-seg-idx">#{seg.index + 1}</span>
                        <span className="dub-seg-range">
                          {fmtTime(seg.start)} → {fmtTime(seg.end)}
                        </span>
                      </div>
                      <div className="dub-seg-texts">
                        <div className="dub-seg-text">{seg.text}</div>
                        {translated[seg.index] && (
                          <div className="dub-seg-translated">
                            <span className="badge badge-accent">{targetLang}</span>
                            {translated[seg.index]}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                  {segments.length > 60 && (
                    <li className="dub-seg-more">
                      … 还有 {segments.length - 60} 条,已折叠
                    </li>
                  )}
                </ul>
                <div className="dub-panel-foot">
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep(3)}
                  >
                    下一步 · 配音生成
                    <Icon name="send" size={14} strokeWidth={2} />
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {/* ── Step 3: 配音 ── */}
        {step === 3 && (
          <section className="card dub-panel">
            <div className="dub-panel-head">
              <h2>配音生成</h2>
              <p>从源视频抽取参考音色,逐段合成克隆配音轨</p>
            </div>

            <div className="dub-form-grid">
              <label className="dub-field">
                <span className="dub-field-label">参考音秒数</span>
                <input
                  className="input"
                  type="number"
                  min={2}
                  max={30}
                  value={refSeconds}
                  onChange={(e) => setRefSeconds(Number(e.target.value) || DEFAULT_DUB_PARAMS.refSeconds)}
                />
                <span className="dub-field-hint">从原音色抽取多长作为克隆参考</span>
              </label>
              <label className="dub-field dub-field-wide">
                <div className="dub-field-label-row">
                  <span className="dub-field-label">情绪提示(可选)</span>
                  <OptimizeButton
                    prompt={emoText}
                    kind="audio"
                    onOptimized={(t) => setEmoText(t)}
                    label="优化提示"
                  />
                </div>
                <input
                  className="input"
                  type="text"
                  placeholder="例:平静 / 激昂 / 低沉"
                  value={emoText}
                  onChange={(e) => setEmoText(e.target.value)}
                />
              </label>
            </div>

            <div className="dub-actions-row">
              <button
                className="btn btn-primary"
                onClick={doVoice}
                disabled={voiceBusy}
              >
                <Icon name={voiceBusy ? "loading" : "audio"} size={14} strokeWidth={2} />
                {voiceBusy ? "合成中…" : "生成配音轨"}
              </button>
              {Object.keys(translated).length > 0 ? (
                <span className="dub-hint-text">使用译文生成</span>
              ) : (
                <span className="dub-hint-text">使用原文字幕生成</span>
              )}
            </div>

            {voiceBusy && (
              <div className="dub-progress">
                <div className="dub-progress-bar" style={{ width: `${voicePct}%` }} />
                <span className="dub-progress-label">
                  {voiceStage} · {voicePct}%
                </span>
              </div>
            )}
            {voiceError && (
              <div className="dub-error">
                <Icon name="error" size={14} strokeWidth={2} />
                {voiceError}
              </div>
            )}

            {/* 空态:暂无音色 */}
            {!voice && !voiceBusy && (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <Icon name="audio" size={56} strokeWidth={1.1} />
                </div>
                <div className="empty-state-title">暂无音色</div>
                <div className="empty-state-desc">
                  请先上传参考音频,或点击上方「生成配音轨」克隆音色
                </div>
              </div>
            )}

            {voice && (
              <div className="dub-voice-result">
                <div className="dub-voice-head">
                  <div className="dub-voice-title">
                    <Icon name="audio" size={14} strokeWidth={2} />
                    {voice.name}
                  </div>
                  <div className="dub-voice-stats">
                    <span className="badge badge-success">
                      <Icon name="success" size={11} strokeWidth={2.4} />
                      合成完成
                    </span>
                    <span className="badge">{voice.segment_count} 段</span>
                    <span className="badge">{fmtTime(voice.duration)}</span>
                  </div>
                </div>
                <audio src={imageUrl(voice.url)} controls preload="metadata" />
                <div className="dub-panel-foot">
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep(4)}
                  >
                    下一步 · 口型同步
                    <Icon name="send" size={14} strokeWidth={2} />
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── Step 4: 对口型 ── */}
        {step === 4 && (
          <section className="card dub-panel">
            <div className="dub-panel-head">
              <h2>口型同步</h2>
              <p>支持 LatentSync 长视频、动漫对口型、AI 精剪三种模式</p>
            </div>

            {/* 模式选择 */}
            <div className="dub-form-grid">
              <div className="dub-field dub-field-wide">
                <span className="dub-field-label">对口型模式</span>
                <div className="dub-segmented">
                  <button
                    className={lipsyncMode === "latent" ? "is-on" : ""}
                    onClick={() => setLipsyncMode("latent")}
                  >
                    LatentSync
                  </button>
                  <button
                    className={lipsyncMode === "anime" ? "is-on" : ""}
                    onClick={() => setLipsyncMode("anime")}
                  >
                    动漫对口型
                  </button>
                  <button
                    className={lipsyncMode === "highlights" ? "is-on" : ""}
                    onClick={() => setLipsyncMode("highlights")}
                  >
                    AI 精剪
                  </button>
                </div>
              </div>
            </div>

            {/* LatentSync 参数 */}
            {lipsyncMode === "latent" && (
              <>
                <div className="dub-form-grid">
                  <div className="dub-field dub-field-wide">
                    <span className="dub-field-label">切片模式</span>
                    <div className="dub-segmented">
                      <button
                        className={cutMode === "even" ? "is-on" : ""}
                        onClick={() => setCutMode("even")}
                      >
                        等分切片
                      </button>
                      <button
                        className={cutMode === "scene" ? "is-on" : ""}
                        onClick={() => setCutMode("scene")}
                      >
                        场景检测
                      </button>
                      <button
                        className={cutMode === "silence" ? "is-on" : ""}
                        onClick={() => setCutMode("silence")}
                      >
                        静音切分
                      </button>
                    </div>
                  </div>

                  {cutMode === "even" ? (
                    <label className="dub-field">
                      <span className="dub-field-label">单段时长(秒)</span>
                      <input
                        className="input"
                        type="number"
                        min={4}
                        max={60}
                        value={segSeconds}
                        onChange={(e) => setSegSeconds(Number(e.target.value) || DEFAULT_DUB_PARAMS.segSeconds)}
                      />
                    </label>
                  ) : (
                    <>
                      <label className="dub-field">
                        <span className="dub-field-label">阈值</span>
                        <input
                          className="input"
                          type="number"
                          step={0.05}
                          min={0.05}
                          max={1}
                          value={threshold}
                          onChange={(e) => setThreshold(Number(e.target.value) || DEFAULT_DUB_PARAMS.threshold)}
                        />
                      </label>
                      <label className="dub-field">
                        <span className="dub-field-label">最短段(秒)</span>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={30}
                          value={minSeg}
                          onChange={(e) => setMinSeg(Number(e.target.value) || DEFAULT_DUB_PARAMS.minSeg)}
                        />
                      </label>
                    </>
                  )}
                </div>

                <button
                  className="btn btn-ghost btn-sm dub-advanced-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <Icon name={showAdvanced ? "close" : "menu"} size={12} strokeWidth={2} />
                  {showAdvanced ? "收起" : "高级选项"}
                </button>

                {showAdvanced && (
                  <div className="dub-form-grid dub-advanced">
                    <label className="dub-field">
                      <span className="dub-field-label">最大段数</span>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={48}
                        value={maxSegments}
                        onChange={(e) => setMaxSegments(Number(e.target.value) || DEFAULT_DUB_PARAMS.maxSegments)}
                      />
                    </label>
                    <label className="dub-field">
                      <span className="dub-field-label">表情强度</span>
                      <input
                        className="input"
                        type="number"
                        step={0.1}
                        min={0}
                        max={3}
                        value={lipsExpression}
                        onChange={(e) => setLipsExpression(Number(e.target.value) || DEFAULT_DUB_PARAMS.lipsExpression)}
                      />
                    </label>
                    <label className="dub-field">
                      <span className="dub-field-label">推理步数</span>
                      <input
                        className="input"
                        type="number"
                        min={5}
                        max={40}
                        value={inferenceSteps}
                        onChange={(e) => setInferenceSteps(Number(e.target.value) || DEFAULT_DUB_PARAMS.inferenceSteps)}
                      />
                    </label>
                  </div>
                )}

                <label className="dub-checkbox">
                  <input
                    type="checkbox"
                    checked={useDubVoice}
                    onChange={(e) => setUseDubVoice(e.target.checked)}
                    disabled={!voice}
                  />
                  <span>
                    使用译制配音轨
                    {!voice && <em> (未生成,将用源视频音轨)</em>}
                  </span>
                </label>
              </>
            )}

            {/* 动漫对口型参数 */}
            {lipsyncMode === "anime" && (
              <div className="dub-form-grid">
                <label className="dub-field">
                  <span className="dub-field-label">张嘴幅度</span>
                  <input
                    className="input"
                    type="number"
                    step={0.1}
                    min={0.1}
                    max={3}
                    value={mouthGain}
                    onChange={(e) => setMouthGain(Number(e.target.value) || DEFAULT_DUB_PARAMS.mouthGain)}
                  />
                  <span className="dub-field-hint">嘴部开合倍率,默认 1.0</span>
                </label>
                <label className="dub-field">
                  <span className="dub-field-label">平滑窗</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={15}
                    value={smooth}
                    onChange={(e) => setSmooth(Number(e.target.value) || DEFAULT_DUB_PARAMS.smooth)}
                  />
                  <span className="dub-field-hint">开口度时间平滑,默认 3</span>
                </label>
                <label className="dub-checkbox dub-field-wide">
                  <input
                    type="checkbox"
                    checked={useDubVoice}
                    onChange={(e) => setUseDubVoice(e.target.checked)}
                    disabled={!voice}
                  />
                  <span>
                    使用译制配音轨
                    {!voice && <em> (未生成,将用源视频音轨)</em>}
                  </span>
                </label>
              </div>
            )}

            {/* AI 精剪参数 */}
            {lipsyncMode === "highlights" && (
              <div className="dub-form-grid">
                <label className="dub-field">
                  <span className="dub-field-label">目标条数</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={50}
                    value={highlightsTarget}
                    onChange={(e) => setHighlightsTarget(Number(e.target.value) || DEFAULT_DUB_PARAMS.highlightsTarget)}
                  />
                  <span className="dub-field-hint">0 = 由 LLM 自动决定</span>
                </label>
                {segments.length === 0 ? (
                  <div className="dub-error dub-field-wide">
                    <Icon name="error" size={14} strokeWidth={2} />
                    AI 精剪需要字幕,请先在步骤 2 生成或导入字幕
                  </div>
                ) : (
                  <span className="dub-hint-text dub-field-wide">
                    将从 {segments.length} 条字幕中挑选高光句
                  </span>
                )}
              </div>
            )}

            <div className="dub-actions-row">
              <button
                className="btn btn-primary"
                onClick={doLipsync}
                disabled={lipsyncBusy}
              >
                <Icon name={lipsyncBusy ? "loading" : "video"} size={14} strokeWidth={2} />
                {lipsyncBusy
                  ? "处理中…"
                  : lipsyncMode === "highlights"
                  ? "生成精剪"
                  : lipsyncMode === "anime"
                  ? "提交动漫对口型"
                  : lipsyncStatus?.status === "done"
                  ? "重新提交"
                  : "提交对口型任务"}
              </button>
              {lipsyncError && (
                <span className="dub-hint-text dub-hint-error">{lipsyncError}</span>
              )}
            </div>

            {/* LatentSync 结果 */}
            {lipsyncMode === "latent" && lipsyncStart && lipsyncStatus && (
              <div className="dub-lipsync-status">
                <div className="dub-status-head">
                  <div
                    className={`dub-status-led is-${lipsyncStatus.status}`}
                  />
                  <div className="dub-status-stage">
                    {lipsyncStatus.stage || lipsyncStatus.status}
                  </div>
                  <div className="dub-status-stats">
                    {lipsyncStatus.total > 0 && (
                      <span className="badge">
                        {lipsyncStatus.completed}/{lipsyncStatus.total} 段
                      </span>
                    )}
                    {lipsyncStatus.fallbacks > 0 && (
                      <span className="badge badge-danger">
                        {lipsyncStatus.fallbacks} 回退
                      </span>
                    )}
                    {lipsyncStatus.gpu_seconds > 0 && (
                      <span className="badge">
                        GPU {Math.round(lipsyncStatus.gpu_seconds)}s
                      </span>
                    )}
                    {lipsyncStatus.elapsed > 0 && (
                      <span className="badge">
                        已用 {fmtTime(lipsyncStatus.elapsed)}
                      </span>
                    )}
                  </div>
                </div>
                {lipsyncStatus.status === "running" && lipsyncStatus.total > 0 && (
                  <div className="dub-progress">
                    <div
                      className="dub-progress-bar"
                      style={{
                        width: `${Math.round((lipsyncStatus.completed / lipsyncStatus.total) * 100)}%`,
                      }}
                    />
                    <span className="dub-progress-label">
                      {Math.round((lipsyncStatus.completed / lipsyncStatus.total) * 100)}%
                    </span>
                  </div>
                )}
                {lipsyncStatus.status === "done" && lipsyncStatus.url && (
                  <div className="dub-lipsync-done">
                    <div className="dub-video-frame">
                      <video
                        src={imageUrl(lipsyncStatus.url)}
                        controls
                        preload="metadata"
                      />
                    </div>
                    <a
                      className="btn btn-primary"
                      href={imageUrl(lipsyncStatus.url)}
                      download
                    >
                      <Icon name="download" size={14} strokeWidth={2} />
                      下载成片
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* 动漫对口型结果 */}
            {lipsyncMode === "anime" && animeStart && animeStatus && (
              <div className="dub-lipsync-status">
                <div className="dub-status-head">
                  <div className={`dub-status-led is-${animeStatus.status}`} />
                  <div className="dub-status-stage">
                    {animeStatus.stage || animeStatus.status}
                  </div>
                  <div className="dub-status-stats">
                    {animeStatus.frames > 0 && (
                      <span className="badge">{animeStatus.frames} 帧</span>
                    )}
                    {animeStatus.faces_detected > 0 && (
                      <span className="badge">
                        {animeStatus.faces_detected} 张脸
                      </span>
                    )}
                    {animeStatus.elapsed > 0 && (
                      <span className="badge">
                        已用 {fmtTime(animeStatus.elapsed)}
                      </span>
                    )}
                  </div>
                </div>
                {animeStatus.status === "running" && animeStatus.progress > 0 && (
                  <div className="dub-progress">
                    <div
                      className="dub-progress-bar"
                      style={{ width: `${Math.round(animeStatus.progress)}%` }}
                    />
                    <span className="dub-progress-label">
                      {Math.round(animeStatus.progress)}%
                    </span>
                  </div>
                )}
                {animeStatus.status === "done" && animeStatus.url && (
                  <div className="dub-lipsync-done">
                    <div className="dub-video-frame">
                      <video
                        src={imageUrl(animeStatus.url)}
                        controls
                        preload="metadata"
                      />
                    </div>
                    <a
                      className="btn btn-primary"
                      href={imageUrl(animeStatus.url)}
                      download
                    >
                      <Icon name="download" size={14} strokeWidth={2} />
                      下载成片
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* AI 精剪结果 */}
            {lipsyncMode === "highlights" && highlightsResult && (
              <div className="dub-lipsync-status">
                <div className="dub-status-head">
                  <div className="dub-status-led is-done" />
                  <div className="dub-status-stage">
                    {highlightsResult.title}
                  </div>
                  <div className="dub-status-stats">
                    <span className="badge badge-success">
                      <Icon name="success" size={11} strokeWidth={2.4} />
                      {highlightsResult.count} 条精剪
                    </span>
                  </div>
                </div>
                <ul className="dub-highlights-list">
                  {highlightsResult.selected.map((idx, i) => {
                    const seg = segments.find((s) => s.index === idx);
                    return (
                      <li key={i} className="dub-highlights-item">
                        <span className="dub-seg-idx">#{idx + 1}</span>
                        <span className="dub-highlights-text">
                          {seg?.text ?? "(字幕缺失)"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>

      <style jsx>{`
        .dub-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-5);
        }

        /* ── 顶部 ── */
        .dub-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          padding-bottom: var(--space-4);
          border-bottom: 1px solid var(--hairline);
        }
        .dub-titles {
          display: flex;
          flex-direction: column;
          gap: 0.1rem;
        }
        .dub-title {
          margin: 0;
          font-family: var(--font-display);
          font-size: 1.6rem;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: var(--ink);
          line-height: 1.1;
        }
        .dub-subtitle {
          margin: 0;
          font-size: 0.78rem;
          color: var(--ink-faint);
          line-height: 1.3;
        }
        .dub-meta {
          display: flex;
          gap: 0.4rem;
          flex-wrap: wrap;
          align-items: center;
        }

        /* ── 步骤指示器 ── */
        .dub-stepper {
          display: flex;
          align-items: stretch;
          gap: 0;
          padding: var(--space-3) var(--space-4);
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .dub-step {
          position: relative;
          display: flex;
          align-items: center;
          gap: 0.6rem;
          flex: 1;
          padding: 0.3rem 0;
          cursor: pointer;
          color: var(--ink-faint);
          transition: color var(--dur) var(--ease);
        }
        .dub-step:hover {
          color: var(--ink-soft);
        }
        .dub-step.is-locked {
          cursor: not-allowed;
          color: var(--ink-faint);
        }
        .dub-step.is-active {
          color: var(--ink);
        }
        .dub-step-circle {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          color: var(--ink-faint);
          font-size: 0.78rem;
          font-weight: 600;
          font-family: var(--font-mono);
          flex-shrink: 0;
          transition: all var(--dur) var(--ease);
        }
        .dub-step.is-active .dub-step-circle {
          background: var(--accent);
          border-color: var(--accent);
          color: var(--accent-ink);
          box-shadow: 0 0 0 4px var(--accent-quiet);
        }
        .dub-step.is-done .dub-step-circle {
          background: var(--success-quiet);
          border-color: var(--success);
          color: var(--success);
        }
        .dub-step-text {
          display: flex;
          flex-direction: column;
          gap: 0;
          min-width: 0;
        }
        .dub-step-label {
          font-size: 0.88rem;
          font-weight: 500;
          letter-spacing: -0.01em;
          line-height: 1.25;
        }
        .dub-step.is-active .dub-step-label {
          color: var(--ink);
        }
        .dub-step-hint {
          font-size: 0.7rem;
          color: var(--ink-faint);
          line-height: 1.2;
          font-family: var(--font-mono);
        }
        .dub-step-line {
          position: absolute;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 1px;
          height: 24px;
          background: var(--hairline);
        }
        @media (max-width: 720px) {
          .dub-stepper {
            overflow-x: auto;
          }
          .dub-step {
            min-width: 110px;
          }
          .dub-step-hint {
            display: none;
          }
        }

        /* ── 步骤容器 ── */
        .dub-stage {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        .dub-panel {
          padding: var(--space-5);
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        @media (max-width: 720px) {
          .dub-panel {
            padding: var(--space-4);
          }
        }
        .dub-panel-head h2 {
          margin: 0 0 0.2rem 0;
          font-family: var(--font-display);
          font-size: 1.15rem;
          font-weight: 500;
          color: var(--ink);
          letter-spacing: -0.02em;
        }
        .dub-panel-head p {
          margin: 0;
          font-size: 0.8rem;
          color: var(--ink-faint);
        }

        /* ── 拖拽区 ── */
        .dub-dropzone {
          display: block;
          cursor: pointer;
          padding: var(--space-6) var(--space-4);
          border: 1.5px dashed var(--hairline-strong);
          border-radius: var(--radius-lg);
          background: var(--bg-sunken);
          transition: all var(--dur) var(--ease);
        }
        .dub-dropzone:hover,
        .dub-dropzone.is-drag {
          border-color: var(--accent);
          background: var(--accent-wash);
        }
        .dub-dropzone-inner {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          color: var(--ink-faint);
        }
        .dub-dropzone.is-drag .dub-dropzone-inner,
        .dub-dropzone:hover .dub-dropzone-inner {
          color: var(--accent-soft);
        }
        .dub-dropzone-title {
          font-size: 0.95rem;
          color: var(--ink-soft);
          font-weight: 500;
        }
        .dub-dropzone-sub {
          font-size: 0.78rem;
          color: var(--ink-faint);
        }
        .dub-dropzone-btn {
          margin-top: 0.5rem;
        }

        /* ── 文件卡片 ── */
        .dub-file-card {
          position: relative;
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-4);
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius);
          flex-wrap: wrap;
        }
        .dub-file-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: var(--radius-sm);
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          color: var(--accent-soft);
          flex-shrink: 0;
        }
        .dub-file-info {
          flex: 1;
          min-width: 180px;
        }
        .dub-file-name {
          font-size: 0.9rem;
          color: var(--ink);
          font-weight: 500;
          word-break: break-all;
        }
        .dub-file-meta {
          font-size: 0.74rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }
        .dub-file-actions {
          display: flex;
          gap: 0.4rem;
          align-items: center;
        }

        /* ── 进度条 ── */
        .dub-progress {
          position: relative;
          width: 100%;
          height: 28px;
          background: var(--bg-sunken);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          overflow: hidden;
        }
        .dub-progress-bar {
          height: 100%;
          background: linear-gradient(
            90deg,
            var(--accent-deep),
            var(--accent) 50%,
            var(--accent-soft)
          );
          background-size: 200% 100%;
          animation: dub-bar-shimmer 2s linear infinite;
          transition: width 0.3s var(--ease);
        }
        @keyframes dub-bar-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: 0 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .dub-progress-bar { animation: none; }
        }
        .dub-progress-label {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.74rem;
          font-family: var(--font-mono);
          color: var(--ink);
          mix-blend-mode: difference;
          letter-spacing: 0.02em;
        }

        /* ── 错误提示 ── */
        .dub-error {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.6rem 0.8rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius-xs);
          color: var(--danger);
          font-size: 0.82rem;
        }

        /* ── 视频结果 ── */
        .dub-video-result {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .dub-video-frame {
          background: var(--bg-sunken);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          overflow: hidden;
          aspect-ratio: 16 / 9;
        }
        .dub-video-frame video,
        .dub-video-frame :global(video) {
          width: 100%;
          height: 100%;
          display: block;
          object-fit: contain;
        }
        .dub-video-summary {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          align-items: flex-start;
        }
        .dub-video-name {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.85rem;
          color: var(--ink);
          font-family: var(--font-mono);
          word-break: break-all;
        }
        .dub-video-stats {
          display: flex;
          gap: 0.4rem;
          flex-wrap: wrap;
        }

        /* ── 操作行 ── */
        .dub-actions-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          flex-wrap: wrap;
        }
        .dub-or {
          font-size: 0.78rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }
        .dub-hint-text {
          font-size: 0.76rem;
          color: var(--ink-faint);
        }
        .dub-hint-error {
          color: var(--danger);
        }

        /* ── 字幕条 ── */
        .dub-subtoolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          flex-wrap: wrap;
          padding-top: var(--space-2);
          border-top: 1px solid var(--hairline);
        }
        .dub-translate {
          display: flex;
          gap: 0.4rem;
          align-items: center;
        }
        .dub-translate-select {
          width: auto;
          min-width: 140px;
        }
        .dub-segments {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          max-height: 460px;
          overflow-y: auto;
        }
        .dub-seg {
          display: grid;
          grid-template-columns: 130px 1fr;
          gap: var(--space-3);
          padding: 0.7rem 0.8rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          transition: border-color var(--dur) var(--ease);
        }
        .dub-seg:hover {
          border-color: var(--accent-line);
        }
        .dub-seg-time {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          font-family: var(--font-mono);
          font-size: 0.72rem;
        }
        .dub-seg-idx {
          color: var(--accent-soft);
          font-weight: 600;
        }
        .dub-seg-range {
          color: var(--ink-faint);
        }
        .dub-seg-texts {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          min-width: 0;
        }
        .dub-seg-text {
          font-size: 0.86rem;
          color: var(--ink);
          line-height: 1.5;
        }
        .dub-seg-translated {
          display: flex;
          gap: 0.4rem;
          align-items: flex-start;
          font-size: 0.84rem;
          color: var(--ink-soft);
          line-height: 1.5;
        }
        .dub-seg-translated :global(.badge) {
          flex-shrink: 0;
          text-transform: uppercase;
          font-family: var(--font-mono);
        }
        .dub-seg-more {
          text-align: center;
          padding: var(--space-3);
          color: var(--ink-faint);
          font-size: 0.8rem;
          font-family: var(--font-mono);
        }
        @media (max-width: 640px) {
          .dub-seg {
            grid-template-columns: 1fr;
            gap: 0.4rem;
          }
          .dub-seg-time {
            flex-direction: row;
            gap: 0.6rem;
            align-items: baseline;
          }
        }

        /* ── 表单 ── */
        .dub-form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: var(--space-3);
        }
        .dub-field {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .dub-field-wide {
          grid-column: 1 / -1;
        }
        .dub-field-label {
          font-size: 0.76rem;
          color: var(--ink-soft);
          letter-spacing: 0.01em;
        }
        .dub-field-label-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .dub-field-hint {
          font-size: 0.7rem;
          color: var(--ink-faint);
        }
        .dub-segmented {
          display: inline-flex;
          background: var(--bg-sunken);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          padding: 2px;
          gap: 2px;
          align-self: flex-start;
        }
        .dub-segmented button {
          padding: 0.4rem 0.8rem;
          background: transparent;
          border: none;
          color: var(--ink-faint);
          font-size: 0.8rem;
          border-radius: var(--radius-xs);
          cursor: pointer;
          transition: all var(--dur) var(--ease);
        }
        .dub-segmented button:hover {
          color: var(--ink-soft);
        }
        .dub-segmented button.is-on {
          background: var(--accent);
          color: var(--accent-ink);
          font-weight: 500;
        }

        /* ── 复选框 ── */
        .dub-checkbox {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.86rem;
          color: var(--ink-soft);
          cursor: pointer;
        }
        .dub-checkbox input {
          width: 16px;
          height: 16px;
          accent-color: var(--accent);
          cursor: pointer;
        }
        .dub-checkbox em {
          color: var(--ink-faint);
          font-style: normal;
        }

        /* ── 高级选项 ── */
        .dub-advanced-toggle {
          align-self: flex-start;
          color: var(--ink-faint);
        }
        .dub-advanced {
          padding: var(--space-3);
          background: var(--bg-sunken);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
        }

        /* ── 配音结果 ── */
        .dub-voice-result {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          padding: var(--space-4);
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius);
        }
        .dub-voice-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          flex-wrap: wrap;
        }
        .dub-voice-title {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.86rem;
          color: var(--ink);
          font-family: var(--font-mono);
          word-break: break-all;
        }
        .dub-voice-stats {
          display: flex;
          gap: 0.4rem;
          flex-wrap: wrap;
        }

        /* ── 面板底部 ── */
        .dub-panel-foot {
          display: flex;
          justify-content: flex-end;
          padding-top: var(--space-3);
          border-top: 1px solid var(--hairline);
        }

        /* ── 对口型状态 ── */
        .dub-lipsync-status {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius);
        }
        .dub-status-head {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .dub-status-led {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--ink-faint);
          flex-shrink: 0;
        }
        .dub-status-led.is-running {
          background: var(--accent);
          animation: dub-led-pulse 1.4s ease-in-out infinite;
        }
        .dub-status-led.is-done {
          background: var(--success);
          box-shadow: 0 0 6px var(--success);
        }
        .dub-status-led.is-error {
          background: var(--danger);
        }
        @keyframes dub-led-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
        @media (prefers-reduced-motion: reduce) {
          .dub-status-led.is-running { animation: none; }
        }
        .dub-status-stage {
          font-size: 0.88rem;
          color: var(--ink);
          font-weight: 500;
          flex: 1;
          min-width: 120px;
        }
        .dub-status-stats {
          display: flex;
          gap: 0.3rem;
          flex-wrap: wrap;
        }
        .dub-lipsync-done {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          align-items: flex-start;
        }

        /* ── AI 精剪结果列表 ── */
        .dub-highlights-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          max-height: 320px;
          overflow-y: auto;
        }
        .dub-highlights-item {
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          padding: 0.55rem 0.7rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          transition: border-color var(--dur) var(--ease);
        }
        .dub-highlights-item:hover {
          border-color: var(--accent-line);
        }
        .dub-highlights-text {
          flex: 1;
          min-width: 0;
          font-size: 0.84rem;
          color: var(--ink);
          line-height: 1.5;
          word-break: break-word;
        }
      `}</style>
    </div>
  );
}
