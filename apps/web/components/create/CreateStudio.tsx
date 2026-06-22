"use client";

import { useCallback, useEffect, useState } from "react";

import { listModels, uploadImage } from "@/lib/api";
import type { ModelsResponse } from "@/lib/types";

import { AssistChat } from "./AssistChat";
import { ProPanel } from "./ProPanel";
import { ResultFeed } from "./ResultFeed";
import { SimplePanel } from "./SimplePanel";
import { useGenerationFeed } from "./useGenerationFeed";
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
  const [ckpt, setCkpt] = useState("");

  // 简易版智能 chip 状态
  const [style, setStyle] = useState<StylePreset>(STYLE_PRESETS[0]);
  const [ratio, setRatio] = useState<SimpleRatioKey>("1:1");
  const [count, setCount] = useState(1);

  const feed = useGenerationFeed();

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        setCkpt(m.checkpoints[0] ?? "");
      })
      .catch(() => {});
  }, []);

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
            run={feed.run}
            style={style}
            setStyle={setStyle}
            ratio={ratio}
            setRatio={setRatio}
            count={count}
            setCount={setCount}
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
            ckpt={ckpt}
            setCkpt={setCkpt}
            busy={feed.busy}
            run={feed.run}
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

        {feed.busy && <div className="chat-typing">{feed.stage || "处理中…"}</div>}

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
