"use client";

import { useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Textarea } from "@/components/ui/Input";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { Tabs } from "@/components/ui/Tabs";
import { GenerateView } from "@/components/generate/GenerateView";
import {
  imageUrl,
  separateAudio,
  synthManjuVoice,
  transcribeDub,
  uploadDubVideo,
  uploadVoiceRef,
  type AudioSeparateResult,
  type ManjuVoiceResult,
} from "@/lib/api";

type AudioTab = "gen" | "edit";

const AUDIO_EXTS = ["mp3", "wav", "flac", "ogg", "m4a"];
const SEP_MAX_BYTES = 50 * 1024 * 1024; // 与后端 /api/audio/separate 上限一致

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 工具卡基座:图标 + 标题 + 简述 + 表单/结果区,三张工具卡共用。 */
function ToolCard({
  icon,
  title,
  desc,
  children,
}: {
  icon: IconName;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <Card className="audio-tool-card">
      <div className="audio-tool-head">
        <span className="audio-tool-icon">
          <Icon name={icon} size={16} />
        </span>
        <div className="audio-tool-headtext">
          <span className="audio-tool-title">{title}</span>
          <span className="audio-tool-desc">{desc}</span>
        </div>
      </div>
      <div className="audio-tool-body">{children}</div>
    </Card>
  );
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

// ── TTS 配音卡 ──────────────────────────────────────────────
// 契约:POST /api/manju/voice { text, emo_text?, ref_audio_url? } → { url, name, duration_sec }(同步);
// 参考音先经 POST /api/manju/voice-ref multipart 上传,返回的 url 作 ref_audio_url 克隆音色。
function TtsCard() {
  const [text, setText] = useState("");
  const [emo, setEmo] = useState("");
  const [refUrl, setRefUrl] = useState("");
  const [refName, setRefName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [synthing, setSynthing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManjuVoiceResult | null>(null);
  const refInputRef = useRef<HTMLInputElement | null>(null);

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

  async function onSynth() {
    if (!text.trim() || synthing) return;
    setError(null);
    setResult(null);
    setSynthing(true);
    try {
      const r = await synthManjuVoice({
        text: text.trim(),
        ...(emo.trim() ? { emo_text: emo.trim() } : {}),
        ...(refUrl ? { ref_audio_url: refUrl } : {}),
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "配音合成失败");
    } finally {
      setSynthing(false);
    }
  }

  return (
    <ToolCard icon="mic" title="TTS 配音" desc="文本转语音(IndexTTS2),可上传参考音克隆音色。">
      <div className="audio-prompt-field">
        <div className="audio-prompt-head">
          <span className="audio-prompt-label">台词文本</span>
          <OptimizeButton
            prompt={text}
            kind="audio"
            onOptimized={(t) => setText(t)}
            disabled={synthing}
          />
        </div>
        <Textarea
          rows={3}
          value={text}
          placeholder="输入要配音的文本(600 字以内)…"
          disabled={synthing}
          aria-label="台词文本"
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      <Field label="情感描述(可选)" hint="如:平静叙述 / 激动 / 低声耳语">
        <Textarea
          rows={1}
          value={emo}
          placeholder="留空则默认语气"
          disabled={synthing}
          aria-label="情感描述"
          onChange={(e) => setEmo(e.target.value)}
        />
      </Field>

      <div className="audio-ref-row">
        <Button
          variant="secondary"
          size="sm"
          loading={uploading}
          icon={<Icon name="upload" size={14} />}
          disabled={synthing}
          onClick={() => refInputRef.current?.click()}
        >
          {uploading ? "上传中…" : "上传参考音色(可选)"}
        </Button>
        {refName && (
          <span className="audio-ref-name" title={refName}>
            <Icon name="check" size={13} />
            {refName}
            <button
              type="button"
              className="audio-ref-clear"
              aria-label="移除参考音"
              onClick={() => {
                setRefUrl("");
                setRefName("");
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        )}
        <input
          ref={refInputRef}
          type="file"
          accept=".mp3,.wav,.flac,.ogg,.m4a"
          style={{ display: "none" }}
          onChange={(e) => void onRefFile(e.target.files?.[0])}
        />
      </div>

      {error && <p className="audio-error">{error}</p>}
      {result && <AudioResult url={result.url} name={result.name} durationSec={result.duration_sec} />}

      <div className="audio-actions">
        <Button
          variant="primary"
          loading={synthing}
          disabled={!text.trim() || uploading}
          icon={<Icon name="audio" size={14} />}
          onClick={() => void onSynth()}
        >
          {synthing ? "合成中…" : "合成配音"}
        </Button>
      </div>
    </ToolCard>
  );
}

// ── ASR 听写卡 ──────────────────────────────────────────────
// 契约:POST /api/dub/upload multipart(video) → { name };POST /api/dub/transcribe { name } → { job_id };
// GET /api/dub/transcribe/{job_id} 轮询 → segments(复用 lib/api transcribeDub 内置轮询)。
// 注:后端 dub/upload 当前仅放行 mp4/mov/webm/mkv;音频文件会收到后端 400 原因,原样展示。
function AsrCard() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<{ index: number; start: number; end: number; text: string }[]>([]);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const transcript = segments.map((s) => s.text).join("\n");

  async function onTranscribe() {
    if (!file || busy) return;
    setError(null);
    setSegments([]);
    setCopied(false);
    setBusy(true);
    setStage("上传文件");
    setPct(0);
    try {
      const up = await uploadDubVideo(file, (p) => setPct(p));
      setStage("启动 Whisper");
      setPct(0);
      const r = await transcribeDub(up.name, (p) => {
        setStage(p.stage || "听写中");
        setPct(p.progress ?? 0);
      });
      setSegments(r.segments);
      setPct(100);
      setStage("完成");
    } catch (e) {
      setError(e instanceof Error ? e.message : "听写失败");
    } finally {
      setBusy(false);
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

  return (
    <ToolCard icon="file" title="ASR 听写" desc="上传音视频文件,faster-whisper 转写为带时间轴的文本。">
      <div className="audio-ref-row">
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="upload" size={14} />}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          选择文件
        </Button>
        {file && (
          <span className="audio-ref-name" title={file.name}>
            {file.name}
          </span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,.flac,.ogg,.m4a,.mp4,.mov,.webm,.mkv"
          style={{ display: "none" }}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
            setSegments([]);
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
      </div>

      {busy && <ToolProgress pct={pct} label={stage} />}
      {error && <p className="audio-error">{error}</p>}

      {segments.length > 0 && (
        <div className="audio-transcript">
          <div className="audio-transcript-head">
            <span className="audio-result-info">{segments.length} 个片段</span>
            <Button variant="ghost" size="sm" icon={<Icon name={copied ? "check" : "file"} size={13} />} onClick={() => void onCopy()}>
              {copied ? "已复制" : "复制全文"}
            </Button>
          </div>
          <Textarea rows={8} readOnly value={transcript} aria-label="转写结果" />
        </div>
      )}

      <div className="audio-actions">
        <Button
          variant="primary"
          loading={busy}
          disabled={!file}
          icon={<Icon name="sparkles" size={14} />}
          onClick={() => void onTranscribe()}
        >
          {busy ? "听写中…" : "开始听写"}
        </Button>
      </div>
    </ToolCard>
  );
}

// ── 人声分离卡 ──────────────────────────────────────────────
// 契约:POST /api/audio/separate multipart(file) → { url, duration_sec }(同步);
// 产物经 GET /api/audio/files/{name} 回读;分离服务 503/502 的 detail 原样展示。
function SeparateCard() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AudioSeparateResult | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  async function onSeparate() {
    if (!file || busy) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await separateAudio(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "人声分离失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolCard icon="audio" title="人声分离" desc="Demucs 从音频中分离人声,输出干声 wav(去 BGM 参考音)。">
      <div className="audio-ref-row">
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="upload" size={14} />}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          选择音频
        </Button>
        {file && (
          <span className="audio-ref-name" title={file.name}>
            {file.name}
          </span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,.flac,.ogg,.m4a"
          style={{ display: "none" }}
          onChange={(e) => {
            onPick(e.target.files?.[0]);
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
      </div>

      {error && <p className="audio-error">{error}</p>}
      {result && (
        <AudioResult
          url={result.url}
          name={result.url.split("/").pop() ?? "vocals.wav"}
          durationSec={result.duration_sec}
        />
      )}

      <div className="audio-actions">
        <Button
          variant="primary"
          loading={busy}
          disabled={!file}
          icon={<Icon name="audio" size={14} />}
          onClick={() => void onSeparate()}
        >
          {busy ? "分离中…" : "开始分离"}
        </Button>
      </div>
    </ToolCard>
  );
}

/**
 * 音频板块(M2):「生成 | 编辑」双页签。
 * - 生成:ACE 文生音乐(统一工作台 lockedKind=audio),舞台独占全高
 * - 编辑:TTS 配音 + ASR 听写 + 人声分离 工具卡(滚动列)
 */
export function AudioView() {
  const [tab, setTab] = useState<AudioTab>("gen");

  return (
    <div className="audio-view">
      <div className="audio-header">
        <Tabs
          ariaLabel="音频模式"
          items={[
            { key: "gen", label: "生成" },
            { key: "edit", label: "编辑" },
          ]}
          current={tab}
          onChange={(k) => setTab(k as AudioTab)}
        />
      </div>

      {tab === "gen" ? (
        <div className="audio-tab-gen">
          <div className="audio-workbench">
            <GenerateView lockedKind="audio" />
          </div>
        </div>
      ) : (
        <div className="audio-tab-edit">
          <TtsCard />
          <AsrCard />
          <SeparateCard />
        </div>
      )}

      <style jsx>{`
        .audio-view {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
        }
        .audio-header {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-5) var(--space-5) 0 calc(var(--space-5) + var(--nav-safe-left)); /* 桌面端让开 CornerNav 触发器 */
          flex-shrink: 0;
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
        /* GenerateView 自带 padding 与板块标题;嵌入时去掉顶部重复留白 */
        .audio-workbench :global(.generate-view) {
          padding-top: var(--space-4);
        }
        /* 歌词 textarea:占位文本与字段说明同源(ParamField hint),说明去重只留占位 */
        .audio-workbench :global(.ui-field:has(textarea) .ui-field-hint) {
          display: none;
        }
        .audio-tab-edit {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: var(--space-4) var(--space-5) var(--space-5);
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          max-width: 760px;
        }

        /* 工具卡 */
        .audio-view :global(.audio-tool-card) {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .audio-tool-head {
          display: flex;
          align-items: flex-start;
          gap: var(--space-2);
        }
        .audio-tool-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: var(--radius-control);
          background: var(--accent-soft);
          color: var(--accent);
          flex-shrink: 0;
        }
        .audio-tool-headtext {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .audio-tool-title {
          font-size: var(--text-sm);
          font-weight: 600;
          color: var(--text-primary);
        }
        .audio-tool-desc {
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.5;
        }
        .audio-tool-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }

        /* 提示词区(与 GenerateView prompt-field 同款头部排布) */
        .audio-prompt-field {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .audio-prompt-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .audio-prompt-label {
          font-size: var(--text-label);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
        }

        /* 上传行 */
        .audio-ref-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .audio-ref-name {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          min-width: 0;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .audio-ref-clear {
          display: inline-flex;
          align-items: center;
          color: var(--text-muted);
          cursor: pointer;
          border-radius: var(--radius-sm);
        }
        .audio-ref-clear:hover {
          color: var(--text-primary);
        }

        /* 进度条(与译制台 dub-progress 同款) */
        .audio-progress {
          position: relative;
          width: 100%;
          height: 28px;
          background: var(--bg-canvas);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          overflow: hidden;
        }
        .audio-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, var(--accent), var(--run));
          transition: width var(--duration-base) var(--ease-standard);
        }
        .audio-progress-label {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: var(--text-aux);
          color: var(--text-primary);
          mix-blend-mode: difference;
        }

        /* 结果区 */
        .audio-result {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-3);
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .audio-player {
          width: 100%;
          height: 36px;
        }
        .audio-result-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .audio-result-info {
          font-size: var(--text-aux);
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }
        .audio-result-download {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-aux);
          color: var(--accent);
          flex-shrink: 0;
        }
        .audio-result-download:hover {
          text-decoration: underline;
        }

        /* 转写结果 */
        .audio-transcript {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .audio-transcript-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }

        .audio-error {
          font-size: var(--text-aux);
          color: var(--err);
        }
        .audio-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }

        @media (max-width: 860px) {
          /* 生成 tab:滚动由 GenerateView 内部承载(stage.css <1024px 纵向堆叠),
             此处保持 flex 定高链,舞台不再被工具卡挤压、页面可滚动 */
          .audio-tab-edit {
            max-width: none;
          }
        }
      `}</style>
    </div>
  );
}
