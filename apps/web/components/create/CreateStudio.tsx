"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useActivity, type ActivityKind } from "@/components/nav/ActivityContext";
import { useNsfw } from "@/components/nav/NsfwContext";
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

/** 空舞台示例提示词:点击填入,降低空白页的上手门槛(图像向通用题材)。 */
const EXAMPLE_PROMPTS = [
  "雪山日出,云海翻涌,电影感光影",
  "赛博朋克城市夜景,霓虹倒影,雨后街道",
  "森林深处发光的蘑菇,梦幻微光氛围",
  "极简产品摄影,柔光,纯色背景,高级质感",
];

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
  // 全局 R18 软开关:关闭时隐藏「NSFW 档」入口(无成人模型可筛);切换时重拉模型列表。
  const { enabled: nsfwEnabled, revision: nsfwRevision } = useNsfw();

  // 简易版智能 chip 状态
  const [style, setStyle] = useState<StylePreset>(STYLE_PRESETS[0]);
  const [ratio, setRatio] = useState<SimpleRatioKey>("1:1");
  const [count, setCount] = useState(1);

  const feed = useGenerationFeed();
  // 本次生成预期产出张数:仅用于驱动骨架占位网格的块数(从派发参数推断)。
  const [pendingCount, setPendingCount] = useState(1);

  // ── 灵动岛实时活动推送 ──
  // 生成时把 feed 的 busy/stage/progress 镜像进全局活动上下文,灵动岛据此长成 live activity;
  // 结束时先打 done(触发完成脉冲)再清空。Mode 是 ActivityKind 的子集,可直接复用。
  const { setActivity, clearActivity } = useActivity();
  const wasBusy = useRef(false);
  useEffect(() => {
    if (feed.busy) {
      setActivity({
        kind: mode as ActivityKind,
        label: prompt,
        value: feed.progress,
        max: feed.progress === null ? null : 100,
        phase: "running",
      });
      wasBusy.current = true;
    } else if (wasBusy.current) {
      // 仅在「曾经忙过」后收尾,避免首次挂载即误触脉冲。
      wasBusy.current = false;
      if (feed.error) {
        clearActivity();
      } else {
        setActivity({ kind: mode as ActivityKind, label: prompt, value: 100, max: 100, phase: "done" });
        const id = window.setTimeout(() => clearActivity(), 760);
        return () => window.clearTimeout(id);
      }
    }
    return undefined;
  }, [feed.busy, feed.progress, feed.error, mode, prompt, setActivity, clearActivity]);

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
    // nsfwRevision 变化(R18 开关切换)时重拉:后端据 nsfw_enabled 服务端过滤模型列表。
  }, [nsfwRevision]);

  // 全局 R18 关闭时,强制把会话内「NSFW 档」筛选也归零(入口已隐藏,避免残留筛选态)。
  useEffect(() => {
    if (!nsfwEnabled && nsfw) setNsfw(false);
  }, [nsfwEnabled, nsfw]);

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
            nsfwEnabled={nsfwEnabled}
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
            nsfwEnabled={nsfwEnabled}
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

        {/* 媒体灯箱井:作品当主角,占满可用高度 */}
        <div className="stage-well">
          {feed.busy && <GenerationProgress stage={feed.stage} progress={feed.progress} />}

          {/* 生成中先铺流光占位网格,结果渐显时替换;结果区与占位区并存,产出即向上插入 */}
          {feed.busy && <GenerationSkeleton count={pendingCount} />}

          {feed.results.length === 0 && !feed.busy ? (
            <div className="editorial-empty stage-empty">
              <span className="ee-orb" aria-hidden="true">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2.5" />
                  <circle cx="8.5" cy="8.5" r="1.8" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              </span>
              <h2>描述你想创作的</h2>
              <p>调好左侧参数后开始生成,作品会在这里展开。</p>
              {mode === "image" && (
                <div className="stage-examples" role="group" aria-label="示例提示词">
                  <span className="stage-examples-label">试试这些 ——</span>
                  {EXAMPLE_PROMPTS.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      className="stage-example-chip"
                      onClick={() => setPrompt(ex)}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              )}
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
        </div>
      </main>
    </div>
  );
}
