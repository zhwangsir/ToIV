"use client";

import { useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Textarea } from "@/components/ui/Input";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { PageHeader } from "@/components/ui/PageHeader";
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
          <Icon name={icon} size={18} />
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
          className="audio-oneline-input"
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
            <span className="audio-ref-label">{refName}</span>
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

      {error && <ErrorBar message={error} onClose={() => setError(null)} />}
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
            <span className="audio-ref-label">{file.name}</span>
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
      {error && <ErrorBar message={error} onClose={() => setError(null)} />}

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
            <span className="audio-ref-label">{file.name}</span>
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

      {error && <ErrorBar message={error} onClose={() => setError(null)} />}
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
      {/* 页头:UI-A PageHeader;布局/避让样式走下方 :global(.page-header*) 覆写 */}
      <PageHeader
        title="音频工坊"
        desc="配乐生成、TTS 配音、ASR 听写与人声分离,一站完成。"
        icon="audio"
        actions={
          <Tabs
            ariaLabel="音频模式"
            items={[
              { key: "gen", label: "生成" },
              { key: "edit", label: "编辑" },
            ]}
            current={tab}
            onChange={(k) => setTab(k as AudioTab)}
          />
        }
      />

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
        /* 页头:统一走全局 .page-header 体系(标题/描述/右侧操作区,桌面端自动避让 CornerNav) */
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
        /* GenerateView 自带 padding 与音频板块一致,避免页头距离异常 */
        .audio-workbench :global(.generate-view) {
          padding-top: var(--space-6);
        }
        /* 歌词 textarea:占位文本与字段说明同源(ParamField hint),说明去重只留占位 */
        .audio-workbench :global(.ui-field:has(textarea) .ui-field-hint) {
          display: none;
        }
        .audio-tab-edit {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: var(--space-5) var(--space-6) var(--space-8);
          display: flex;
          flex-direction: column;
          gap: var(--space-6); /* 卡片间距 16→24,拉开工具卡层级 */
          width: 100%;
          max-width: 880px; /* 内容列 760→880,配合更宽松的卡内留白 */
          margin: 0 auto; /* 宽屏下内容列居中,不再贴左侧 */
        }

        /* 工具卡(头部/表单/结果均由子组件渲染,styled-jsx 作用域不跨组件,统一走 :global) */
        .audio-view :global(.audio-tool-card) {
          display: flex;
          flex-direction: column;
          gap: var(--space-5);
          padding: var(--space-6); /* 卡内留白 20→24,舒展优先 */
          transition: transform var(--duration-base) var(--ease-standard),
                      border-color var(--duration-fast) var(--ease-standard),
                      box-shadow var(--duration-fast) var(--ease-standard);
        }
        /* hover 升浮反馈:描边加强 + 浮起投影 + 轻微上移 */
        .audio-view :global(.audio-tool-card:hover) {
          transform: translateY(-2px);
          border-color: var(--border-strong);
          box-shadow: var(--shadow-lift);
        }
        .audio-view :global(.audio-tool-head) {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding-bottom: var(--space-4);
          border-bottom: 1px solid var(--border-subtle); /* 卡头/卡体分层线 */
        }
        .audio-view :global(.audio-tool-icon) {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px; /* 28→36,与加大后的卡头层级匹配 */
          height: 36px;
          border-radius: var(--radius-panel);
          background: var(--accent-soft);
          color: var(--accent);
          flex-shrink: 0;
        }
        .audio-view :global(.audio-tool-headtext) {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          min-width: 0;
        }
        .audio-view :global(.audio-tool-title) {
          font-size: var(--text-section); /* 区块标题档位 15px/600 */
          font-weight: var(--font-semibold);
          line-height: 1.35;
          color: var(--text-primary);
        }
        .audio-view :global(.audio-tool-desc) {
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.5;
        }
        .audio-view :global(.audio-tool-body) {
          display: flex;
          flex-direction: column;
          gap: var(--space-4); /* 表单分组间距 12→16 */
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
          resize: none;
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
          max-width: 100%; /* 长文件名不顶破卡片 */
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
          border-radius: var(--radius-sm);
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

        /* 结果区:嵌套面板加大留白与圆角,与卡体拉开层级 */
        .audio-view :global(.audio-result) {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4); /* 12→16 */
          background: var(--bg-surface-2); /* 卡内嵌面板只降一档,不跳到 surface-3 */
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel); /* 8→12,与外层卡片同族 */
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

        .audio-view :global(.audio-actions) {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }

        @media (max-width: 1023px) {
          /* 生成 tab:滚动由 GenerateView 内部承载(stage.css <1024px 纵向堆叠),
             此处保持 flex 定高链,舞台不再被工具卡挤压、页面可滚动 */
          .audio-tab-edit {
            max-width: none;
            padding: var(--space-4) var(--space-5) var(--space-6);
          }
        }

        /* 音频板块页头:标题/描述与段控水平紧邻,避免 space-between 造成的大片留白 */
        .audio-view :global(.page-header) {
          justify-content: flex-start;
          align-items: flex-start;
          gap: var(--space-4);
          margin-bottom: var(--space-4);
        }
        .audio-view :global(.page-header-actions) {
          align-self: flex-start;
          padding-top: 2px;
        }

        /* 移动端:触控目标 ≥44px,主操作撑满整行 */
        @media (max-width: 767px) {
          .audio-tab-edit {
            padding: var(--space-4) var(--space-4) var(--space-6);
            gap: var(--space-4);
          }
          .audio-view :global(.audio-tool-card) {
            padding: var(--space-5);
          }
          .audio-view :global(.audio-actions .btn) {
            width: 100%;
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
