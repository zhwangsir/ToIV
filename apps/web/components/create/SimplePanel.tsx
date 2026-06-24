"use client";

import { useCallback } from "react";

import { OptimizeButton } from "@/components/ui/OptimizeButton";
import type { ModelsResponse } from "@/lib/types";

import { hasNsfwData } from "./nsfw";
import type { Dispatch } from "./useGenerationFeed";
import {
  type Mode,
  type RefImage,
  type SimpleRatioKey,
  type StylePreset,
  DEFAULT_NEGATIVE,
  IMG_RATIO_PX,
  SIMPLE_RATIOS,
  STYLE_PRESETS,
  VID_RATIO_PX,
} from "./types";

import "./create-extra.css";

interface SimplePanelProps {
  mode: Mode;
  setMode: (m: Mode) => void;
  prompt: string;
  setPrompt: (p: string) => void;
  ref: RefImage | null;
  setRef: (r: RefImage | null) => void;
  ensureUploaded: (r: RefImage, kind: string) => Promise<{ filename: string; worker: string }>;
  ckpt: string;
  busy: boolean;
  run: (dispatches: Dispatch[], stage: string) => Promise<void>;
  // 智能 chip 状态(由父持有,简易/专业共享 prompt 但各管各的 chip)
  style: StylePreset;
  setStyle: (s: StylePreset) => void;
  ratio: SimpleRatioKey;
  setRatio: (r: SimpleRatioKey) => void;
  count: number;
  setCount: (n: number) => void;
  // NSFW 档(简易/专业共享);models 用于判断后端是否提供 nsfw 标记
  models: ModelsResponse | null;
  nsfw: boolean;
  setNsfw: (v: boolean) => void;
}

const MODE_TABS: { key: Mode; icon: string; label: string }[] = [
  { key: "image", icon: "🖼", label: "图像" },
  { key: "video", icon: "🎬", label: "视频" },
  { key: "model3d", icon: "⬢", label: "3D" },
  { key: "audio", icon: "♪", label: "音频" },
];

function withStyle(prompt: string, style: StylePreset): string {
  const p = prompt.trim();
  if (!style.suffix) return p;
  return p ? `${p}, ${style.suffix}` : style.suffix;
}

/** 简易版:极简、零门槛,智能默认隐藏所有高级参数。 */
export function SimplePanel(props: SimplePanelProps) {
  const {
    mode, setMode, prompt, setPrompt, ref, setRef, ensureUploaded, ckpt, busy, run,
    style, setStyle, ratio, setRatio, count, setCount, models, nsfw, setNsfw,
  } = props;

  const pickFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      setRef({ previewUrl: URL.createObjectURL(file), file });
    },
    [setRef],
  );

  const showRatio = mode === "image" || mode === "video";
  const showCount = mode === "image" && !ref;
  // 视频:有参考图 → 图生视频;无 → 文生视频。3D 必须有图;音频纯文本。
  const i2v = mode === "video" && !!ref;
  const canRun =
    mode === "audio"
      ? !!prompt.trim()
      : mode === "model3d"
        ? !!ref
        : !!(prompt.trim() || ref);

  const submit = useCallback(async () => {
    if (busy || !canRun) return;
    const positive = withStyle(prompt, style);

    if (mode === "image") {
      if (ref) {
        const up = await ensureUploaded(ref, "img2img");
        await run(
          [{
            type: "img2img",
            prompt,
            meta: { ckpt, beforeUrl: ref.previewUrl },
            params: {
              positive: positive || "enhance, high quality, detailed",
              negative: DEFAULT_NEGATIVE,
              ckpt_name: ckpt,
              image: up.filename,
              worker: up.worker,
              denoise: 0.6,
              steps: 20,
              cfg: 7,
              sampler: "euler",
              scheduler: "normal",
            },
          }],
          "重绘中…",
        );
      } else {
        const { w, h } = IMG_RATIO_PX[ratio];
        await run(
          [{
            type: "txt2img",
            prompt,
            meta: { ckpt, width: w, height: h },
            params: {
              positive,
              negative: DEFAULT_NEGATIVE,
              ckpt_name: ckpt,
              width: w,
              height: h,
              steps: 20,
              cfg: 7,
              sampler: "euler",
              scheduler: "normal",
              batch_size: count,
            },
          }],
          count > 1 ? `生成 ${count} 张…` : "生成中…",
        );
      }
      return;
    }

    if (mode === "video") {
      const { w, h } = VID_RATIO_PX[ratio];
      if (i2v && ref) {
        const up = await ensureUploaded(ref, "video");
        await run(
          [{
            type: "video",
            prompt,
            params: {
              positive: positive || "subtle natural motion, cinematic",
              image: up.filename,
              worker: up.worker,
              width: w,
              height: h,
              length: 81,
              fps: 16,
            },
          }],
          "图生视频…(约 1-2 分钟)",
        );
      } else {
        await run(
          [{
            type: "txt2video",
            prompt,
            params: {
              positive: positive || "cinematic motion, smooth camera",
              negative: DEFAULT_NEGATIVE,
              width: w,
              height: h,
              length: 81,
              fps: 16,
            },
          }],
          "文生视频…(约 1-2 分钟)",
        );
      }
      return;
    }

    if (mode === "model3d" && ref) {
      const up = await ensureUploaded(ref, "threed");
      await run(
        [{
          type: "model3d",
          prompt,
          params: { image: up.filename, worker: up.worker, steps: 30, cfg: 5, octree_resolution: 256 },
        }],
        "生成 3D…(约 1-3 分钟)",
      );
      return;
    }

    if (mode === "audio") {
      await run(
        [{ type: "audio", prompt, params: { tags: prompt.trim(), lyrics: "", seconds: 30 } }],
        "创作音乐…",
      );
    }
  }, [busy, canRun, prompt, style, mode, ref, ensureUploaded, ckpt, ratio, count, i2v, run]);

  const optimizeKind = mode === "audio" ? "audio" : mode === "video" ? "video" : ref ? "image_edit" : "image";
  const placeholder =
    mode === "audio"
      ? "描述风格,如:lofi hip hop, 钢琴, 90bpm"
      : mode === "video"
        ? i2v
          ? "描述运动,如:镜头缓慢推进,花瓣飘落"
          : "描述画面与运动,如:雪山日出,云海翻涌,镜头推进"
        : mode === "model3d"
          ? "上传物体图即可生成 3D(提示词可选)"
          : ref
            ? "描述想把图片改成什么样"
            : "描述你想要的画面,越具体越好";

  const btnLabel = busy
    ? "生成中…"
    : mode === "video"
      ? i2v ? "图生视频" : "文生视频"
      : mode === "model3d"
        ? "生成 3D"
        : mode === "audio"
          ? "生成音乐"
          : ref ? "重绘" : count > 1 ? `生成 ${count} 张` : "一键生成";

  return (
    <div className="simple-panel">
      {/* 模式图标 tab */}
      <div className="mode-tabs" role="group" aria-label="创作模式">
        {MODE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={mode === t.key ? "active" : ""}
            onClick={() => setMode(t.key)}
          >
            <span className="mode-ico" aria-hidden="true">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* 参考图:拖/传即自动切到图生流程 */}
      {mode !== "audio" && (
        <div className="simple-ref">
          {ref ? (
            <div className="ref-preview">
              <img src={ref.previewUrl} alt="参考图" />
              <button type="button" className="ref-remove" onClick={() => setRef(null)} aria-label="移除参考图">
                ✕
              </button>
              <span className="ref-tag">
                {mode === "video" ? "图生视频" : mode === "model3d" ? "图生 3D" : "图生图"}
              </span>
            </div>
          ) : (
            <label className="dropzone dropzone-sm">
              <input type="file" accept="image/*" hidden onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
              {mode === "model3d" ? "上传物体图(必需)" : "拖入参考图 → 自动图生"}
            </label>
          )}
        </div>
      )}

      {/* 大提示词 + AI 优化 */}
      <div className="simple-prompt">
        <textarea
          rows={4}
          placeholder={placeholder}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <OptimizeButton value={prompt} kind={optimizeKind} onResult={setPrompt} disabled={busy} />
      </div>

      {/* 智能 chip */}
      {mode !== "model3d" && mode !== "audio" && (
        <div className="chip-row" role="group" aria-label="风格">
          <span className="chip-row-label">风格</span>
          {STYLE_PRESETS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`smart-chip ${style.key === s.key ? "active" : ""}`}
              onClick={() => setStyle(s)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {showRatio && (
        <div className="chip-row" role="group" aria-label="比例">
          <span className="chip-row-label">比例</span>
          {SIMPLE_RATIOS.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`smart-chip ${ratio === r.key ? "active" : ""}`}
              onClick={() => setRatio(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {showCount && (
        <div className="chip-row" role="group" aria-label="数量">
          <span className="chip-row-label">数量</span>
          {[1, 2, 4].map((n) => (
            <button
              key={n}
              type="button"
              className={`smart-chip ${count === n ? "active" : ""}`}
              onClick={() => setCount(n)}
            >
              {n} 张
            </button>
          ))}
        </div>
      )}

      {/* NSFW 档(仅图像):开关 + 18+ 角标;实际底模筛选与切换由共享 ckpt 中央处理 */}
      {mode === "image" && (
        <div className={`nsfw-gate${nsfw ? " is-on" : ""}`}>
          <div className="switch-row">
            <span className="switch-label">
              NSFW 档
              {nsfw && <span className="nsfw-badge">18+</span>}
              <span className="switch-sub">
                {hasNsfwData(models, "image")
                  ? "切到成人向底模(vpred 自适配)"
                  : "后端暂未提供 nsfw 标记 · 暂用默认底模"}
              </span>
            </span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={nsfw}
              aria-label="NSFW 档"
              onClick={() => setNsfw(!nsfw)}
            />
          </div>
        </div>
      )}

      <button type="button" className="generate-btn" disabled={busy || !canRun} onClick={submit}>
        {btnLabel}
      </button>
    </div>
  );
}
