"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Textarea } from "@/components/ui/Input";
import { GenerateView } from "@/components/generate/GenerateView";
import { useAutoResize } from "@/hooks/useAutoResize";
import {
  imageUrl,
  invalidateJobs,
  separateAudio,
  synthManjuVoice,
  transcribeDub,
  uploadDubVideo,
  uploadVoiceRef,
  type AudioSeparateResult,
  type ManjuVoiceResult,
} from "@/lib/api";
import { isParseAbortError } from "@/lib/studioParseUx";
import { begin as genBegin, end as genEnd } from "@/lib/generationBus";

type AudioTab = "gen" | "edit";
type EditTool = "tts" | "asr" | "separate";

const AUDIO_EXTS = ["mp3", "wav", "flac", "ogg", "m4a"];
const SEP_MAX_BYTES = 50 * 1024 * 1024; // 与后端 /api/audio/separate 上限一致

/** 编辑工具注册表(2026-09-02 舞台化:左列切换 + 中央舞台,替代旧三卡堆叠)。 */
const EDIT_TOOLS: { key: EditTool; icon: IconName; name: string; desc: string; stageEmpty: string }[] = [
  { key: "tts", icon: "mic", name: "TTS 配音", desc: "文本转语音(IndexTTS2),可上传参考音克隆音色。", stageEmpty: "配音产物将在这里呈现" },
  { key: "asr", icon: "file", name: "ASR 听写", desc: "上传音视频文件,faster-whisper 转写为带时间轴的文本。", stageEmpty: "转写结果将在这里呈现" },
  { key: "separate", icon: "audio", name: "人声分离", desc: "Demucs 从音频中分离人声,输出干声 wav(去 BGM 参考音)。", stageEmpty: "分离产物将在这里呈现" },
];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 任务进度条(与译制台同款:渐变条 + 百分比/阶段文案)。 */
function ToolProgress({ pct, label }: { pct: number; label?: string }) {
  return (
    <div className="audio-progress">
      <div className="audio-progress-bar" style={{ width: `${Math.round(pct)}%` }} />
      <span className="audio-progress-label">
        {label ? `${label} · ` : ""}
        {Math.round(pct)}%
      </span>
    </div>
  );
}

/** 产物结果区:音频播放器 + 时长 + 下载链接(imageUrl 拼 token,<audio>/<a> 无法带请求头)。 */
function AudioResult({ url, name, durationSec }: { url: string; name: string; durationSec: number | null }) {
  const full = imageUrl(url);
  return (
    <div className="audio-result">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio controls src={full} className="audio-player" />
      <div className="audio-result-meta">
        <span className="audio-result-info">
          {name}
          {durationSec != null ? ` · ${durationSec.toFixed(1)}s` : ""}
        </span>
        <a href={full} download={name} className="audio-result-download">
          <Icon name="download" size={13} />
          下载
        </a>
      </div>
    </div>
  );
}

/** 舞台中央进行中状态(无百分比工具用:spinner + 一句状态)。 */
function StageBusy({ label }: { label: string }) {
  return (
    <div className="audio-stage-busy">
      <span className="loading-spinner" aria-hidden="true" />
      <span className="audio-stage-busy-text">{label}</span>
    </div>
  );
}

// ── TTS 配音 ──────────────────────────────────────────────
// 契约:POST /api/manju/voice { text, emo_text?, ref_audio_url? } → { url, name, duration_sec }(同步);
// 参考音先经 POST /api/manju/voice-ref multipart 上传,返回的 url 作 ref_audio_url 克隆音色。
function useTtsTool() {
  const [text, setText] = useState("");
  const [emo, setEmo] = useState("");
  // 台词/情感描述自动增高(长台词不再 rows=3 截断;情感描述保留 36px 单行下限)
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const emoRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(textRef, text);
  useAutoResize(emoRef, emo);
  const [refUrl, setRefUrl] = useState("");
  const [refName, setRefName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [synthing, setSynthing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManjuVoiceResult | null>(null);
  const refInputRef = useRef<HTMLInputElement | null>(null);
  const synthAbortRef = useRef<AbortController | null>(null);

  async function onRefFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const r = await uploadVoiceRef(file);
      setRefUrl(r.url);
      setRefName(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "参考音上传失败");
    } finally {
      setUploading(false);
      if (refInputRef.current) refInputRef.current.value = "";
    }
  }

  function onStopSynth() {
    synthAbortRef.current?.abort();
  }

  async function onSynth() {
    if (!text.trim() || synthing) return;
    setError(null);
    setResult(null);
    setSynthing(true);
    genBegin("audio-tts", "TTS 配音合成");
    const ac = new AbortController();
    synthAbortRef.current = ac;
    try {
      const r = await synthManjuVoice({
        text: text.trim(),
        ...(emo.trim() ? { emo_text: emo.trim() } : {}),
        ...(refUrl ? { ref_audio_url: refUrl } : {}),
      }, { signal: ac.signal });
      setResult(r);
      // 配音产物经后端 Job 建档(kind=manju_voice)后作品库可见;
      // 失效缓存让下次进作品库立即拉到最新(与图像/视频生成同口径)
      invalidateJobs();
    } catch (e) {
      if (!isParseAbortError(e)) {
        setError(e instanceof Error ? e.message : "配音合成失败");
      }
    } finally {
      if (synthAbortRef.current === ac) synthAbortRef.current = null;
      setSynthing(false);
      genEnd("audio-tts");
    }
  }

  return {
    text, setText, emo, setEmo, textRef, emoRef,
    refUrl, setRefUrl, refName, setRefName, uploading, synthing, error, setError, result,
    refInputRef, onRefFile, onSynth, onStopSynth,
  };
}
type TtsTool = ReturnType<typeof useTtsTool>;

function TtsForm({ t }: { t: TtsTool }) {
  return (
    <>
      <div className="audio-prompt-field">
        <div className="audio-prompt-head">
          <span className="audio-prompt-label">台词文本</span>
          {/* 台词是要念出来的内容,不接提示词优化(会被改写成英文标签串,内容损毁) */}
        </div>
        <Textarea
          ref={t.textRef}
          rows={3}
          value={t.text}
          placeholder="输入要配音的文本(600 字以内)…"
          disabled={t.synthing}
          aria-label="台词文本"
          onChange={(e) => t.setText(e.target.value)}
        />
      </div>

      <Field label="情感描述(可选)" hint="如:平静叙述 / 激动 / 低声耳语">
        <Textarea
          ref={t.emoRef}
          rows={1}
          className="audio-oneline-input"
          value={t.emo}
          placeholder="留空则默认语气"
          disabled={t.synthing}
          aria-label="情感描述"
          onChange={(e) => t.setEmo(e.target.value)}
        />
      </Field>

      <div className="audio-ref-row">
        <Button
          variant="secondary"
          size="sm"
          loading={t.uploading}
          icon={<Icon name="upload" size={14} />}
          disabled={t.synthing}
          onClick={() => t.refInputRef.current?.click()}
        >
          {t.uploading ? "上传中…" : "上传参考音色(可选)"}
        </Button>
        {t.refName && (
          <span className="audio-ref-name" title={t.refName}>
            <Icon name="check" size={13} />
            <span className="audio-ref-label">{t.refName}</span>
            <button
              type="button"
              className="audio-ref-clear"
              aria-label="移除参考音"
              onClick={() => {
                t.setRefUrl("");
                t.setRefName("");
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        )}
        <input
          ref={t.refInputRef}
          type="file"
          accept=".mp3,.wav,.flac,.ogg,.m4a"
          style={{ display: "none" }}
          onChange={(e) => void t.onRefFile(e.target.files?.[0])}
        />
      </div>
    </>
  );
}

function TtsActions({ t }: { t: TtsTool }) {
  return t.synthing ? (
    <Button
      variant="danger"
      icon={<Icon name="close" size={14} />}
      title="中止合成请求(断开到 IndexTTS 的连接)"
      onClick={t.onStopSynth}
    >
      中止合成
    </Button>
  ) : (
    <Button
      variant="primary"
      disabled={!t.text.trim() || t.uploading}
      icon={<Icon name="audio" size={14} />}
      onClick={() => void t.onSynth()}
    >
      合成配音
    </Button>
  );
}

function TtsStage({ t }: { t: TtsTool }) {
  return (
    <>
      {t.error && <ErrorBar message={t.error} onClose={() => t.setError(null)} />}
      {t.result ? (
        <div className="audio-stage-scroll">
          <div className="audio-stage-content">
            <AudioResult url={t.result.url} name={t.result.name} durationSec={t.result.duration_sec} />
          </div>
        </div>
      ) : t.synthing ? (
        <StageBusy label="IndexTTS 合成中…" />
      ) : (
        <span className="empty-console-hint">配音产物将在这里呈现</span>
      )}
    </>
  );
}

// ── ASR 听写 ──────────────────────────────────────────────
// 契约:POST /api/dub/upload multipart(video) → { name };POST /api/dub/transcribe { name } → { job_id };
// GET /api/dub/transcribe/{job_id} 轮询 → segments(复用 lib/api transcribeDub 内置轮询)。
// 注:后端 dub/upload 当前仅放行 mp4/mov/webm/mkv;音频文件会收到后端 400 原因,原样展示。
function useAsrTool() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<{ index: number; start: number; end: number; text: string }[]>([]);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const asrAbortRef = useRef<AbortController | null>(null);

  const transcript = segments.map((s) => s.text).join("\n");

  function onStopAsr() {
    asrAbortRef.current?.abort();
  }

  async function onTranscribe() {
    if (!file || busy) return;
    setError(null);
    setSegments([]);
    setCopied(false);
    setBusy(true);
    setStage("上传文件");
    setPct(0);
    genBegin("audio-asr", "ASR 听写");
    const ac = new AbortController();
    asrAbortRef.current = ac;
    try {
      const up = await uploadDubVideo(file, (p) => setPct(p));
      if (ac.signal.aborted) throw new DOMException("已中止", "AbortError");
      setStage("启动 Whisper");
      setPct(0);
      const r = await transcribeDub(up.name, (p) => {
        setStage(p.stage || "听写中");
        setPct(p.progress ?? 0);
      }, ac.signal);
      setSegments(r.segments);
      setPct(100);
      setStage("完成");
    } catch (e) {
      if (!isParseAbortError(e)) {
        setError(e instanceof Error ? e.message : "听写失败");
      }
    } finally {
      if (asrAbortRef.current === ac) asrAbortRef.current = null;
      setBusy(false);
      genEnd("audio-asr");
    }
  }

  async function onCopy() {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败,请手动选择文本复制");
    }
  }

  return {
    file, setFile, busy, stage, pct, error, setError,
    segments, setSegments, copied, transcript, inputRef,
    onTranscribe, onStopAsr, onCopy,
  };
}
type AsrTool = ReturnType<typeof useAsrTool>;

function AsrForm({ t }: { t: AsrTool }) {
  return (
    <div className="audio-ref-row">
      <Button
        variant="secondary"
        size="sm"
        icon={<Icon name="upload" size={14} />}
        disabled={t.busy}
        onClick={() => t.inputRef.current?.click()}
      >
        选择文件
      </Button>
      {t.file && (
        <span className="audio-ref-name" title={t.file.name}>
          <span className="audio-ref-label">{t.file.name}</span>
        </span>
      )}
      <input
        ref={t.inputRef}
        type="file"
        accept=".mp3,.wav,.flac,.ogg,.m4a,.mp4,.mov,.webm,.mkv"
        style={{ display: "none" }}
        onChange={(e) => {
          t.setFile(e.target.files?.[0] ?? null);
          t.setError(null);
          t.setSegments([]);
          if (t.inputRef.current) t.inputRef.current.value = "";
        }}
      />
    </div>
  );
}

function AsrActions({ t }: { t: AsrTool }) {
  return t.busy ? (
    <Button
      variant="danger"
      icon={<Icon name="close" size={14} />}
      title="中止听写作业(cancelJob;本地 Whisper 本段可能跑完但结果丢弃)"
      onClick={t.onStopAsr}
    >
      中止听写
    </Button>
  ) : (
    <Button
      variant="primary"
      disabled={!t.file}
      icon={<Icon name="sparkles" size={14} />}
      onClick={() => void t.onTranscribe()}
    >
      开始听写
    </Button>
  );
}

function AsrStage({ t }: { t: AsrTool }) {
  return (
    <>
      {t.error && <ErrorBar message={t.error} onClose={() => t.setError(null)} />}
      {t.segments.length > 0 ? (
        <div className="audio-stage-scroll">
          <div className="audio-stage-content audio-transcript">
            <div className="audio-transcript-head">
              <span className="audio-result-info">{t.segments.length} 个片段</span>
              <Button variant="ghost" size="sm" icon={<Icon name={t.copied ? "check" : "file"} size={13} />} onClick={() => void t.onCopy()}>
                {t.copied ? "已复制" : "复制全文"}
              </Button>
            </div>
            <Textarea rows={12} readOnly value={t.transcript} aria-label="转写结果" />
          </div>
        </div>
      ) : t.busy ? (
        <div className="audio-stage-busy-col">
          <ToolProgress pct={t.pct} label={t.stage} />
        </div>
      ) : (
        <span className="empty-console-hint">转写结果将在这里呈现</span>
      )}
    </>
  );
}

// ── 人声分离 ──────────────────────────────────────────────
// 契约:POST /api/audio/separate multipart(file) → { url, duration_sec }(同步);
// 产物经 GET /api/audio/files/{name} 回读;分离服务 503/502 的 detail 原样展示。
function useSeparateTool() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AudioSeparateResult | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sepAbortRef = useRef<AbortController | null>(null);

  function onPick(f: File | undefined) {
    setError(null);
    setResult(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!AUDIO_EXTS.includes(fileExt(f.name))) {
      setFile(null);
      setError(`不支持的音频格式(允许:${AUDIO_EXTS.join("/")})`);
      return;
    }
    if (f.size > SEP_MAX_BYTES) {
      setFile(null);
      setError("音频超过 50MB 上限");
      return;
    }
    setFile(f);
  }

  function onStopSeparate() {
    sepAbortRef.current?.abort();
  }

  async function onSeparate() {
    if (!file || busy) return;
    setError(null);
    setResult(null);
    setBusy(true);
    genBegin("audio-separate", "人声分离");
    const ac = new AbortController();
    sepAbortRef.current = ac;
    try {
      setResult(await separateAudio(file, { signal: ac.signal }));
    } catch (e) {
      if (!isParseAbortError(e)) {
        setError(e instanceof Error ? e.message : "人声分离失败");
      }
    } finally {
      if (sepAbortRef.current === ac) sepAbortRef.current = null;
      setBusy(false);
      genEnd("audio-separate");
    }
  }

  return {
    file, busy, error, setError, result, inputRef,
    onPick, onSeparate, onStopSeparate,
  };
}
type SeparateTool = ReturnType<typeof useSeparateTool>;

function SeparateForm({ t }: { t: SeparateTool }) {
  return (
    <div className="audio-ref-row">
      <Button
        variant="secondary"
        size="sm"
        icon={<Icon name="upload" size={14} />}
        disabled={t.busy}
        onClick={() => t.inputRef.current?.click()}
      >
        选择音频
      </Button>
      {t.file && (
        <span className="audio-ref-name" title={t.file.name}>
          <span className="audio-ref-label">{t.file.name}</span>
        </span>
      )}
      <input
        ref={t.inputRef}
        type="file"
        accept=".mp3,.wav,.flac,.ogg,.m4a"
        style={{ display: "none" }}
        onChange={(e) => {
          t.onPick(e.target.files?.[0]);
          if (t.inputRef.current) t.inputRef.current.value = "";
        }}
      />
    </div>
  );
}

function SeparateActions({ t }: { t: SeparateTool }) {
  return t.busy ? (
    <Button
      variant="danger"
      icon={<Icon name="close" size={14} />}
      title="中止分离请求(断开到 Demucs 的连接)"
      onClick={t.onStopSeparate}
    >
      中止分离
    </Button>
  ) : (
    <Button
      variant="primary"
      disabled={!t.file}
      icon={<Icon name="audio" size={14} />}
      onClick={() => void t.onSeparate()}
    >
      开始分离
    </Button>
  );
}

function SeparateStage({ t }: { t: SeparateTool }) {
  return (
    <>
      {t.error && <ErrorBar message={t.error} onClose={() => t.setError(null)} />}
      {t.result ? (
        <div className="audio-stage-scroll">
          <div className="audio-stage-content">
            <AudioResult
              url={t.result.url}
              name={t.result.url.split("/").pop() ?? "vocals.wav"}
              durationSec={t.result.duration_sec}
            />
          </div>
        </div>
      ) : t.busy ? (
        <StageBusy label="Demucs 分离中…" />
      ) : (
        <span className="empty-console-hint">分离产物将在这里呈现</span>
      )}
    </>
  );
}

/**
 * 音频板块(M2):「生成 | 编辑」双页签。
 * - 生成:ACE 文生音乐(统一工作台 lockedKind=audio),舞台独占全高
 * - 编辑:TTS 配音 + ASR 听写 + 人声分离
 *   2026-09-02 舞台化:旧三卡堆叠 → 左参数列(工具切换+表单+钉底操作)+ 中央舞台
 *   (空态一行提示 / 进行中进度 / 结果),与图像/视频工作台同一范式;
 *   三工具状态经 hooks 驻留本层,切换工具不丢草稿。
 */
export function AudioView() {
  const [tab, setTab] = useState<AudioTab>("gen");
  const [tool, setTool] = useState<EditTool>("tts");
  const tts = useTtsTool();
  const asr = useAsrTool();
  const sep = useSeparateTool();
  const activeMeta = EDIT_TOOLS.find((t) => t.key === tool) ?? EDIT_TOOLS[0];

  return (
    /* Film Atelier(P0-1):根容器补 .view-shell 节奏,页头不再贴左边缘 */
    <div className="audio-view view-shell">
      {/* 2026-08-18 页头移除(灵动岛已指示当前板块):仅保留生成/编辑段控窄行 */}
      <div className="audio-mode-row">
        <div className="at-seg" role="tablist" aria-label="音频模式">
          {(["gen", "edit"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={`at-seg-btn${tab === k ? " is-active" : ""}`}
              onClick={() => setTab(k)}
            >
              <Icon name={k === "gen" ? "sparkles" : "scissors"} size={14} />
              {k === "gen" ? "生成" : "编辑"}
            </button>
          ))}
        </div>
      </div>

      {tab === "gen" ? (
        <div className="audio-tab-gen">
          <div className="audio-workbench">
            <GenerateView lockedKind="audio" />
          </div>
        </div>
      ) : (
        <div className="audio-edit-body">
          {/* 左参数列:工具切换 + 当前工具表单(滚动)+ 钉底主操作 */}
          <aside className="audio-edit-params">
            <nav className="audio-edit-tools" role="tablist" aria-label="编辑工具">
              {EDIT_TOOLS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tool === t.key}
                  title={t.desc}
                  className={`audio-edit-tool${tool === t.key ? " is-active" : ""}`}
                  onClick={() => setTool(t.key)}
                >
                  <Icon name={t.icon} size={15} />
                  <span className="audio-edit-tool-name">{t.name}</span>
                </button>
              ))}
            </nav>
            <div className="audio-edit-form">
              <p className="audio-edit-tooldesc">{activeMeta.desc}</p>
              {tool === "tts" && <TtsForm t={tts} />}
              {tool === "asr" && <AsrForm t={asr} />}
              {tool === "separate" && <SeparateForm t={sep} />}
            </div>
            <div className="audio-edit-actions">
              {tool === "tts" && <TtsActions t={tts} />}
              {tool === "asr" && <AsrActions t={asr} />}
              {tool === "separate" && <SeparateActions t={sep} />}
            </div>
          </aside>

          {/* 中央舞台:空态一行提示 / 进行中进度 / 结果;错误条置顶 */}
          <div className="audio-edit-stage">
            {tool === "tts" && <TtsStage t={tts} />}
            {tool === "asr" && <AsrStage t={asr} />}
            {tool === "separate" && <SeparateStage t={sep} />}
          </div>
        </div>
      )}

      <style jsx>{`
        .audio-view {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
          /* 全高工作台:底距收敛(view-shell 默认 space-12 文档节奏,此处舞台贴底呼吸即可) */
          padding-top: var(--space-4);
          padding-bottom: var(--space-4);
        }
        /* 段控窄行(页头已移除):仅高度 ~32px,首屏还给工作台 */
        .audio-mode-row {
          flex-shrink: 0;
          display: flex;
          padding: 0 0 var(--space-3);
        }
        .audio-tab-gen {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .audio-workbench {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        /* 内嵌工作台:水平/底部留白由 .view-shell 承担,舞台与页头左缘对齐 */
        .audio-workbench :global(.generate-view) {
          padding: var(--space-4) 0 0;
        }
        /* 歌词 textarea:占位文本与字段说明同源(ParamField hint),说明去重只留占位 */
        .audio-workbench :global(.ui-field:has(textarea) .ui-field-hint) {
          display: none;
        }

        /* ── 编辑 tab 舞台化(2026-09-02):左参数列 + 中央舞台 ──
           与 GenerateView 同一范式:参数列真实网格位(非浮板),舞台面板岛;
           工具切换行内 2px 左指示条沿用 SideRail 当前项语言 */
        .audio-edit-body {
          flex: 1;
          min-height: 0;
          display: flex;
          gap: var(--space-3);
          align-items: stretch;
        }
        .audio-edit-params {
          width: 340px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          overflow: hidden;
        }
        /* 工具切换(列顶,hairline 与表单分层) */
        .audio-edit-tools {
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: var(--space-2);
          border-bottom: 1px solid var(--border-subtle);
        }
        .audio-edit-tool {
          position: relative;
          display: flex;
          align-items: center;
          gap: var(--space-2);
          height: 34px;
          padding: 0 var(--space-3);
          border: none;
          border-radius: var(--radius-control);
          background: transparent;
          color: var(--text-muted);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
                      background-color var(--duration-fast) var(--ease-standard);
        }
        .audio-edit-tool:hover {
          color: var(--text-primary);
          background: var(--bg-surface-2);
        }
        .audio-edit-tool.is-active {
          color: var(--accent);
          background: var(--accent-soft);
        }
        /* 当前工具:左侧 2px 指示条(落入列 padding 缝,不压行内容) */
        .audio-edit-tool.is-active::before {
          content: "";
          position: absolute;
          left: -4px;
          top: 8px;
          bottom: 8px;
          width: 2px;
          border-radius: 1px;
          background: var(--accent);
        }
        .audio-edit-form {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          scrollbar-width: thin;
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          padding: var(--space-4);
        }
        .audio-edit-tooldesc {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.5;
        }
        /* 主操作钉列底,hairline 与表单分层 */
        .audio-edit-actions {
          flex-shrink: 0;
          display: flex;
          padding: var(--space-3) var(--space-4);
          border-top: 1px solid var(--border-subtle);
        }
        .audio-edit-actions :global(.btn) {
          width: 100%;
        }

        /* 中央舞台:与 generate-results 同款面板岛 */
        .audio-edit-stage {
          flex: 1;
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          overflow: hidden;
        }
        /* 结果滚动区:内容限宽居中(播放器/转写不铺满大舞台) */
        .audio-stage-scroll {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          scrollbar-width: thin;
          display: flex;
          flex-direction: column;
        }
        .audio-stage-content {
          width: 100%;
          max-width: 640px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        /* 进行中(无百分比):居中 spinner + 状态行 */
        .audio-stage-busy {
          margin: auto;
          display: flex;
          align-items: center;
          gap: var(--space-2);
          color: var(--text-muted);
          font-size: var(--text-aux);
        }
        /* 进行中(有百分比):居中限宽进度条 */
        .audio-stage-busy-col {
          margin: auto;
          width: min(420px, 80%);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }

        /* 提示词区(与 GenerateView prompt-field 同款头部排布) */
        .audio-view :global(.audio-prompt-field) {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .audio-view :global(.audio-prompt-head) {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .audio-view :global(.audio-prompt-label) {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
        }
        /* 单行 textarea(如情感描述 rows=1):抵消全局 textarea 80px min-height,按单行控件渲染 */
        .audio-view :global(.audio-oneline-input) {
          min-height: 36px;
          resize: vertical;
        }

        /* 上传行:虚线投放区样式,与表单控件拉开材质层级 */
        .audio-view :global(.audio-ref-row) {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
          padding: var(--space-3) var(--space-4);
          background: var(--bg-canvas);
          border: 1px dashed var(--border-strong);
          border-radius: var(--radius-panel);
          transition: border-color var(--duration-fast) var(--ease-standard),
                      background-color var(--duration-fast) var(--ease-standard);
        }
        .audio-view :global(.audio-ref-row:hover) {
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .audio-view :global(.audio-ref-name) {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          min-width: 0;
          max-width: 100%; /* 长文件名不顶破面板 */
          padding: 2px var(--space-2);
          background: var(--bg-surface-2);
          border-radius: var(--radius-badge);
          font-size: var(--text-aux);
          color: var(--text-secondary);
        }
        /* 文件名文本:独立 span 承载省略号(flex 容器自身不做 text-overflow) */
        .audio-view :global(.audio-ref-label) {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .audio-view :global(.audio-ref-clear) {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          flex-shrink: 0;
          color: var(--text-muted);
          cursor: pointer;
          border-radius: var(--radius-badge);
          transition: color var(--duration-fast) var(--ease-standard),
                      background-color var(--duration-fast) var(--ease-standard);
        }
        .audio-view :global(.audio-ref-clear:hover) {
          color: var(--text-primary);
          background: var(--bg-surface-3);
        }

        /* 进度条(与译制台 dub-progress 同款) */
        .audio-view :global(.audio-progress) {
          position: relative;
          width: 100%;
          height: 28px;
          background: var(--bg-canvas);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          overflow: hidden;
        }
        .audio-view :global(.audio-progress-bar) {
          height: 100%;
          background: linear-gradient(90deg, var(--accent), var(--run));
          transition: width var(--duration-base) var(--ease-standard);
        }
        .audio-view :global(.audio-progress-label) {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: var(--text-aux);
          /* on-accent(近白)+ difference:空轨上呈深色、进度条(深)上呈浅色,全程可读 */
          color: var(--text-on-accent);
          mix-blend-mode: difference;
          letter-spacing: 0.02em;
          font-variant-numeric: tabular-nums;
        }

        /* 结果区:嵌套面板加大留白与圆角,与舞台拉开层级 */
        .audio-view :global(.audio-result) {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
        }
        .audio-view :global(.audio-player) {
          width: 100%;
          height: 40px;
        }
        .audio-view :global(.audio-result-meta) {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .audio-view :global(.audio-result-info) {
          font-size: var(--text-aux);
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }
        .audio-view :global(.audio-result-download) {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-2);
          margin: calc(-1 * var(--space-1)) calc(-1 * var(--space-2)); /* 加大热区不撑开布局 */
          border-radius: var(--radius-control);
          font-size: var(--text-aux);
          color: var(--accent);
          flex-shrink: 0;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .audio-view :global(.audio-result-download:hover) {
          background: var(--accent-soft);
        }

        /* 转写结果 */
        .audio-view :global(.audio-transcript) {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .audio-view :global(.audio-transcript-head) {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }

        @media (max-width: 1023px) {
          /* 窄屏:参数列/舞台纵向堆叠,页面滚动;工具切换横排 */
          .audio-edit-body {
            flex-direction: column;
            overflow-y: auto;
          }
          .audio-edit-params {
            width: 100%;
            flex-shrink: 0;
            overflow: visible;
          }
          .audio-edit-tools {
            flex-direction: row;
            gap: var(--space-1);
          }
          .audio-edit-tool {
            flex: 1;
            justify-content: center;
          }
          .audio-edit-tool.is-active::before {
            display: none;
          }
          .audio-edit-form {
            overflow: visible;
          }
          .audio-edit-stage {
            flex-shrink: 0;
            min-height: 320px;
          }
        }

        /* 移动端:触控目标 ≥44px,主操作撑满整行 */
        @media (max-width: 767px) {
          .audio-view {
            padding: var(--space-3) var(--space-3) var(--space-3);
          }
          .audio-edit-actions :global(.btn) {
            min-height: 44px;
          }
          .audio-view :global(.audio-ref-row .btn) {
            min-height: 44px;
          }
          .audio-view :global(.audio-ref-clear) {
            width: 32px;
            height: 32px;
          }
          .audio-view :global(.audio-result-download) {
            padding: var(--space-2);
            margin: calc(-1 * var(--space-2));
          }
        }
      `}</style>
    </div>
  );
}
