"use client";

import { useCallback, useEffect, useState } from "react";

import { listLocalModels, listModels, uploadImage } from "@/lib/api";
import type { ModelsResponse } from "@/lib/types";

import { AssistChat } from "./AssistChat";
import { GenerationProgress } from "./GenerationProgress";
import { GenerationSkeleton } from "./GenerationSkeleton";
import { filterModelsByNsfw } from "./nsfw";
import { ProPanel } from "./ProPanel";
import { ResultFeed } from "./ResultFeed";
import { SimplePanel } from "./SimplePanel";
import { useGenerationFeed, type Dispatch } from "./useGenerationFeed";
import {
  type Mode,
  type RefImage,
  type ResultItem,
  type SimpleRatioKey,
  type StylePreset,
  STYLE_PRESETS,
  modeLabel,
} from "./types";

/**
 * 统一创作台:顶部「简易 ⇄ 专业」双层切换。
 * - 简易:零门槛,智能默认,一键生成
 * - 专业:全控制面板,可折叠高级 + 工作流预设
 * 结果流支持续创作(转视频/转3D/重绘/变体)。
 */
export function CreateStudio() {
  const [tier, setTier] = useState<"simple" | "pro">("simple");
  const [mode, setMode] = useState<Mode>("image");
  const [prompt, setPrompt] = useState("");
  const [ref, setRef] = useState<RefImage | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [loraOptions, setLoraOptions] = useState<string[]>([]);
  const [ckpt, setCkpt] = useState("");
  // NSFW 档(简易/专业共享):开启 → 图像底模筛选到 nsfw 模型(契约缺失优雅降级为全部)。
  const [nsfw, setNsfw] = useState(false);

  // 简易版智能 chip 状态
  const [style, setStyle] = useState<StylePreset>(STYLE_PRESETS[0]);
  const [ratio, setRatio] = useState<SimpleRatioKey>("1:1");
  const [count, setCount] = useState(1);

  const feed = useGenerationFeed();
  // 本次生成预期产出张数:仅用于驱动骨架占位网格的块数(从派发参数推断)。
  const [pendingCount, setPendingCount] = useState(1);

  // 包裹 feed.run:在派发前从首个 dispatch 的 batch_size 推断占位块数。
  const runTracked = useCallback(
    (dispatches: Dispatch[], stage: string) => {
      const first = dispatches[0];
      const n =
        first && "params" in first && "batch_size" in first.params
          ? (first.params.batch_size ?? 1)
          : 1;
      setPendingCount(n);
      return feed.run(dispatches, stage);
    },
    [feed],
  );

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        // 图像底模优先用模式感知列表(已剔除音频/3D 等非图像 checkpoint)
        const imageList = m.modes?.image?.models ?? m.checkpoints;
        setCkpt(imageList[0] ?? "");
      })
      .catch(() => {});
    listLocalModels()
      .then((local) => setLoraOptions(local.loras ?? []))
      .catch(() => {});
  }, []);

  // NSFW 档切换 / 模型加载后:若共享 ckpt 落在筛选列表外,中央纠正到首项,
  // 让简易与专业两侧的图像底模选择保持一致(单一真相)。
  useEffect(() => {
    if (!models) return;
    const baseList = models.modes?.image?.models ?? models.checkpoints ?? [];
    const list = filterModelsByNsfw(baseList, models, "image", nsfw);
    if (list.length > 0 && !list.includes(ckpt)) {
      setCkpt(list[0]);
    }
  }, [models, nsfw, ckpt]);

  // 释放参考图预览 URL(仅本地 blob)
  useEffect(() => {
    return () => {
      if (ref?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(ref.previewUrl);
    };
  }, [ref]);

  const ensureUploaded = useCallback(
    async (r: RefImage, kind: string) => {
      if (r.uploaded) return r.uploaded;
      const up = await uploadImage(r.file, kind);
      setRef((cur) => (cur ? { ...cur, uploaded: up } : cur));
      return up;
    },
    [],
  );

  // 续创作:重绘 / 变体 —— 把结果图喂回输入区,切到图像模式
  const onReuse = useCallback(
    async (item: ResultItem, asVariation: boolean) => {
      if (feed.busy) return;
      const file = await feed.fileFromResult(item);
      setRef({ previewUrl: item.url, file });
      setMode("image");
      if (asVariation) {
        setPrompt(item.prompt);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [feed],
  );

  return (
    <div className="studio create-studio">
      <div className="panel create-panel">
        {/* 简易 ⇄ 专业 */}
        <div className="tier-switch" role="group" aria-label="创作模式层级">
          <button type="button" className={tier === "simple" ? "active" : ""} onClick={() => setTier("simple")}>
            简易
          </button>
          <button type="button" className={tier === "pro" ? "active" : ""} onClick={() => setTier("pro")}>
            专业
          </button>
          <span className="tier-hint">{tier === "simple" ? "零门槛 · 智能默认" : "全参数 · 精准控制"}</span>
        </div>

        {tier === "simple" ? (
          <SimplePanel
            mode={mode}
            setMode={setMode}
            prompt={prompt}
            setPrompt={setPrompt}
            ref={ref}
            setRef={setRef}
            ensureUploaded={ensureUploaded}
            ckpt={ckpt}
            busy={feed.busy}
            run={runTracked}
            style={style}
            setStyle={setStyle}
            ratio={ratio}
            setRatio={setRatio}
            count={count}
            setCount={setCount}
            models={models}
            nsfw={nsfw}
            setNsfw={setNsfw}
          />
        ) : (
          <ProPanel
            mode={mode}
            setMode={setMode}
            prompt={prompt}
            setPrompt={setPrompt}
            ref={ref}
            setRef={setRef}
            ensureUploaded={ensureUploaded}
            models={models}
            nsfw={nsfw}
            setNsfw={setNsfw}
            loraOptions={loraOptions}
            ckpt={ckpt}
            setCkpt={setCkpt}
            busy={feed.busy}
            run={runTracked}
          />
        )}

        {feed.error && (
          <div className="alert" onClick={feed.dismissError} role="button" title="点击关闭">
            ⚠ {feed.error}
          </div>
        )}

        <AssistChat context={prompt} onApplyPrompt={setPrompt} />
      </div>

      <main className="stage">
        <div className="stage-head">
          <h1>
            创作 <span className="grad">{modeLabel(mode)}</span>
          </h1>
          <span className="count">{feed.results.length} 件</span>
        </div>

        {feed.busy && <GenerationProgress stage={feed.stage} progress={feed.progress} />}

        {/* 生成中先铺流光占位网格,结果渐显时替换;结果区与占位区并存,产出即向上插入 */}
        {feed.busy && <GenerationSkeleton count={pendingCount} />}

        {feed.results.length === 0 && !feed.busy ? (
          <div className="hero-canvas">
            <div className="hero-orb" aria-hidden="true" />
          </div>
        ) : (
          <ResultFeed
            results={feed.results}
            busy={feed.busy}
            onReuse={onReuse}
            onToVideo={feed.continueToVideo}
            onTo3D={feed.continueTo3D}
          />
        )}
      </main>
    </div>
  );
}
