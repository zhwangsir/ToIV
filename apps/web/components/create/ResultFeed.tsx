"use client";

import { useState } from "react";

import { motion } from "framer-motion";

import { CompareSlider } from "@/components/ui/CompareSlider";
import { ModelViewer } from "@/components/ui/ModelViewer";
import { developVariants } from "@/lib/motion";

import type { ResultItem } from "./types";

interface ResultFeedProps {
  results: ResultItem[];
  busy: boolean;
  /** 把某张图作为参考图重新喂回输入区(重绘 / 变体)。 */
  onReuse: (item: ResultItem, asVariation: boolean) => void;
  onToVideo: (item: ResultItem) => void;
  onTo3D: (item: ResultItem) => void;
}

function MediaTile({ item }: { item: ResultItem }) {
  // 重绘/变体:有原图 → 拖动对比(before/after)
  const [compare, setCompare] = useState(true);
  const beforeUrl = item.meta?.beforeUrl;

  if (item.kind === "model3d") {
    return (
      <div className="chat-model3d create-media">
        <ModelViewer src={item.url} />
      </div>
    );
  }
  if (item.kind === "audio") {
    return (
      <div className="create-audio">
        <span className="audio-badge">♪ 音乐</span>
        <audio controls preload="none" src={item.url} />
      </div>
    );
  }
  if (item.kind === "video") {
    return <video className="create-media" src={item.url} controls loop muted playsInline />;
  }
  if (beforeUrl && compare) {
    return (
      <div className="create-media compare-media">
        <CompareSlider beforeSrc={beforeUrl} afterSrc={item.url} alt={item.prompt || "结果"} />
        <button type="button" className="compare-toggle" onClick={() => setCompare(false)} title="关闭对比">
          单图
        </button>
      </div>
    );
  }
  return (
    <div className="create-media-wrap">
      <img className="create-media" src={item.url} alt={item.prompt || "结果"} loading="lazy" />
      {beforeUrl && (
        <button type="button" className="compare-toggle" onClick={() => setCompare(true)} title="拖动对比">
          对比
        </button>
      )}
    </div>
  );
}

/** 结果流:每张图带「续创作」动作,让用户不重配参数就迭代。 */
export function ResultFeed({ results, busy, onReuse, onToVideo, onTo3D }: ResultFeedProps) {
  return (
    <div className="create-feed">
      {results.map((r) => (
        <motion.figure
          className="create-card"
          key={r.id}
          variants={developVariants}
          initial="initial"
          animate="enter"
        >
          <MediaTile item={r} />

          {r.kind === "image" && (
            <div className="card-actions">
              <button type="button" onClick={() => onToVideo(r)} disabled={busy}>
                转视频
              </button>
              <button type="button" onClick={() => onTo3D(r)} disabled={busy}>
                转 3D
              </button>
              <button type="button" onClick={() => onReuse(r, false)} disabled={busy}>
                重绘
              </button>
              <button type="button" onClick={() => onReuse(r, true)} disabled={busy}>
                变体
              </button>
              <a href={r.url} download>
                下载
              </a>
            </div>
          )}
          {r.kind === "video" && (
            <div className="card-actions card-actions-thin">
              <a href={r.url} download>
                下载视频
              </a>
            </div>
          )}
          {r.kind === "model3d" && (
            <div className="card-actions card-actions-thin">
              <a href={r.url} download>
                下载 GLB
              </a>
            </div>
          )}

          {r.kind === "video" && <span className="media-tag">▶ 视频</span>}
          {r.kind === "model3d" && <span className="media-tag">⬢ 3D · 可旋转</span>}
        </motion.figure>
      ))}
    </div>
  );
}
