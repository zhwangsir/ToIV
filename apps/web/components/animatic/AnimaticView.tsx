"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { genId } from "@/lib/id";
import {
  animaticVideoUrl,
  createAnimatic,
  type AnimaticResult,
} from "@/lib/animatic";
import {
  createDramaProjectFromImage,
  type DramaFromImageResult,
} from "@/lib/api";

// 与后端 apps/api/app/routes/animatic.py 保持一致的限制
const MAX_IMAGES = 20;
// AI 解析模式走 /api/drama/projects/from-image,上限 9 张
const AI_MAX_IMAGES = 9;
const MAX_BYTES = 20 * 1024 * 1024;
const EXT_OK = ["jpg", "jpeg", "png", "webp"];
const DEFAULT_DURATION = 3.0;
// 默认每镜时长可调范围(stitch 模式,UI 暴露)
const DURATION_MIN = 1;
const DURATION_MAX = 10;

const RESOLUTIONS = [
  { label: "1080p · 1920×1080", width: 1920, height: 1080 },
  { label: "720p · 1280×720", width: 1280, height: 720 },
] as const;

// AI 模式可选分镜数(契约 4-16,默认 8)
const NUM_SHOTS_OPTIONS = [4, 6, 8, 10, 12, 14, 16] as const;

type Mode = "ai" | "stitch";

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

export function AnimaticView({
  onOpenDramaProject,
}: {
  /** AI 解析成功后跳转短剧工作室打开项目;未注入时仅提示用户自行前往 */
  onOpenDramaProject?: (projectId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("ai");
  const [items, setItems] = useState<Item[]>([]);
  const [fps, setFps] = useState(24);
  const [resIdx, setResIdx] = useState(0);
  const [defaultDuration, setDefaultDuration] = useState(DEFAULT_DURATION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnimaticResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { show: showToast } = useToast();

  // AI 解析模式参数与结果
  const [hint, setHint] = useState("");
  const [numShots, setNumShots] = useState(8);
  const [aiResult, setAiResult] = useState<DramaFromImageResult | null>(null);

  const isAi = mode === "ai";
  const maxImages = isAi ? AI_MAX_IMAGES : MAX_IMAGES;

  // 卸载时回收全部 objectURL
  useEffect(() => {
    return () => {
      setItems((prev) => {
        prev.forEach((it) => URL.revokeObjectURL(it.preview));
        return prev;
      });
    };
  }, []);

  // 模式切换:已选图数超目标模式上限时 toast 提示并阻止切换;切换成功则重置上一次结果态
  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode || busy) return;
      const nextMax = next === "ai" ? AI_MAX_IMAGES : MAX_IMAGES;
      if (items.length > nextMax) {
        showToast(
          "error",
          `已选 ${items.length} 张,超出「${next === "ai" ? "AI 解析" : "快速拼接"}」模式上限 ${nextMax} 张,请先移除多余分镜图`,
        );
        return;
      }
      setMode(next);
      setResult(null);
      setAiResult(null);
      setError(null);
    },
    [mode, busy, items.length, showToast],
  );

  const totalDuration = items.reduce((s, it) => s + (it.duration || 0), 0);

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      const picked = Array.from(files);
      if (items.length + picked.length > maxImages) {
        setError(`当前模式最多 ${maxImages} 张分镜图(已选 ${items.length} 张)`);
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
        duration: defaultDuration,
      }));
      setItems((prev) => [...prev, ...next]);
      setResult(null);
      setAiResult(null);
    },
    [items.length, maxImages, defaultDuration],
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

  const submitAi = useCallback(async () => {
    if (items.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setAiResult(null);
    const res = RESOLUTIONS[resIdx];
    try {
      const data = await createDramaProjectFromImage({
        images: items.map((it) => it.file),
        hint: hint.trim() || undefined,
        num_shots: numShots,
        width: res.width,
        height: res.height,
        fps: 16, // 短剧管线固定 16fps(LTX 原生帧率,与 DramaProject 默认一致)
        auto: true, // 后台自动跑完整管线(分镜视频 → 配音 → 合成)
      });
      setAiResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败");
    } finally {
      setBusy(false);
    }
  }, [items, hint, numShots, resIdx, busy]);

  return (
    <div className="single-view animatic-view">
      <header className="page-header">
        <div>
          <h1 className="page-header-title">动态分镜</h1>
          <p className="page-header-desc">
            {isAi
              ? "上传分镜图,VLM 自动解析剧情并生成完整短剧(分镜视频 + 配音 + 成片)"
              : "上传分镜图,设置每镜时长,串成一条可播放的 animatic 视频"}
          </p>
        </div>
        <div className="page-header-actions">
          <span className="badge">
            <Icon name="film" size={13} />
            {items.length} / {maxImages} 镜{!isAi && ` · 共 ${totalDuration.toFixed(1)}s`}
          </span>
        </div>
      </header>

      <div className="anim-mode-switch" role="tablist" aria-label="生成模式">
        <button
          type="button"
          role="tab"
          aria-selected={isAi}
          className={`anim-mode-tab${isAi ? " is-on" : ""}`}
          disabled={busy}
          onClick={() => switchMode("ai")}
        >
          <Icon name="sparkles" size={14} />
          AI 解析生成完整短剧
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!isAi}
          className={`anim-mode-tab${!isAi ? " is-on" : ""}`}
          disabled={busy}
          onClick={() => switchMode("stitch")}
        >
          <Icon name="clapperboard" size={14} />
          快速拼接预览
        </button>
      </div>

      <button
        type="button"
        className="anim-drop"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        <span className="anim-drop-icon" aria-hidden="true">
          <Icon name="upload" size={22} />
        </span>
        <span className="anim-drop-title">点击选择分镜图(可多张)</span>
        <span className="anim-drop-hint">
          jpg / png / webp · 单张 ≤ 20MB · 最多 {maxImages} 张
          {isAi ? "" : " · 顺序即播放顺序"}
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
                {!isAi && (
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
                )}
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

      {isAi && (
        <div className="anim-params">
          <div className="anim-params-head">
            <span className="anim-params-title">生成参数</span>
            <span className="anim-params-desc">
              VLM 按故事方向拆分分镜,自动跑完整管线(分镜视频 → 配音 → 成片)
            </span>
          </div>
          <div className="anim-params-body">
          <label className="anim-field anim-field-grow">
            <span className="anim-field-label">故事方向(可选)</span>
            <textarea
              className="input anim-hint-input"
              rows={2}
              placeholder="例:赛博朋克都市里,赏金猎人追捕叛逃的仿生人…"
              value={hint}
              disabled={busy}
              onChange={(e) => setHint(e.target.value)}
            />
          </label>
          <label className="anim-field">
            <span className="anim-field-label">分镜数量</span>
            <select
              className="input"
              value={numShots}
              disabled={busy}
              onChange={(e) => setNumShots(Number.parseInt(e.target.value, 10))}
            >
              {NUM_SHOTS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} 镜
                </option>
              ))}
            </select>
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
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={busy || items.length === 0}
            onClick={submitAi}
          >
            {busy ? (
              <>
                <Icon name="loading" size={16} />
                VLM 解析图片中…(可能需要 1-2 分钟)
              </>
            ) : (
              <>
                <Icon name="sparkles" size={16} />
                解析并生成短剧
              </>
            )}
          </button>
          </div>
        </div>
      )}

      {!isAi && (
        <div className="anim-params">
          <div className="anim-params-head">
            <span className="anim-params-title">生成参数</span>
            <span className="anim-params-desc">
              帧率与默认时长作用于整条 animatic;单镜时长可在卡片上单独调整
            </span>
          </div>
          <div className="anim-params-body">
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
            <span className="anim-field-label">默认每镜时长 (秒)</span>
            <input
              type="number"
              className="input anim-fps-input"
              min={DURATION_MIN}
              max={DURATION_MAX}
              step={0.5}
              value={defaultDuration}
              disabled={busy}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (!Number.isFinite(v)) return;
                setDefaultDuration(
                  Math.min(DURATION_MAX, Math.max(DURATION_MIN, v)),
                );
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
        </div>
      )}

      {error && (
        <div className="anim-error" role="alert">
          <Icon name="error" size={15} />
          <span>{error}</span>
        </div>
      )}

      {!isAi && result && (
        <section className="anim-result anim-result-panel">
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

      {isAi && aiResult && (
        <section className="anim-result">
          <div className="anim-result-head">
            <Icon name="success" size={16} />
            <span>短剧项目已创建,后台自动生成中</span>
          </div>
          <div className="anim-ai-result">
            <div className="anim-ai-result-title">{aiResult.project.title}</div>
            {aiResult.project.premise && (
              <p className="anim-ai-result-premise">{aiResult.project.premise}</p>
            )}
            <div className="anim-ai-result-meta">
              共 {aiResult.shots.length} 个分镜
              {aiResult.autorun_task_id ? " · 完整管线已自动启动" : ""}
            </div>
            {onOpenDramaProject ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onOpenDramaProject(aiResult.project.id)}
              >
                <Icon name="drama" size={16} />
                前往短剧工作室查看生成进度
              </button>
            ) : (
              <p className="anim-ai-result-hint">
                请到「短剧工作室」查看项目生成进度
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
