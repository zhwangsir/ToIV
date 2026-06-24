"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { motion } from "framer-motion";

import { CompareSlider } from "@/components/ui/CompareSlider";
import { Magnifier } from "@/components/ui/Magnifier";
import { ModelViewer } from "@/components/ui/ModelViewer";
import { developVariants } from "@/lib/motion";

import "./result-feed.css";

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
      <Magnifier src={item.url} alt={item.prompt || "结果"} className="create-media" zoom={2.4} />
      {beforeUrl && (
        <button type="button" className="compare-toggle" onClick={() => setCompare(true)} title="拖动对比">
          对比
        </button>
      )}
    </div>
  );
}

/** 不可变重排:把数组中 from 位置的元素移动到 to 位置,返回新数组。 */
function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) {
    return arr.slice();
  }
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * 结果流:每张图带「续创作」动作,让用户不重配参数就迭代。
 * 支持拖拽重排(HTML5 DnD):本地维护展示顺序(以 id 序列为真相),
 * 新结果到达时合并进序列头部,手动顺序不丢失。所有更新均不可变。
 */
export function ResultFeed({ results, busy, onReuse, onToVideo, onTo3D }: ResultFeedProps) {
  // 展示顺序的真相:id 序列。结果由 hook 前插,故新 id 合并到序列前部、保留既有手排序。
  const [order, setOrder] = useState<string[]>(() => results.map((r) => r.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  useEffect(() => {
    setOrder((prev) => {
      const liveIds = new Set(results.map((r) => r.id));
      const known = new Set(prev);
      // 新 id(hook 前插)按结果原顺序补到序列头部
      const incoming = results.map((r) => r.id).filter((id) => !known.has(id));
      // 保留既有手排序,剔除已消失的 id
      const kept = prev.filter((id) => liveIds.has(id));
      if (incoming.length === 0 && kept.length === prev.length) return prev;
      return [...incoming, ...kept];
    });
  }, [results]);

  // id → 结果项 映射,按 order 渲染
  const byId = useMemo(() => {
    const m = new Map<string, ResultItem>();
    for (const r of results) m.set(r.id, r);
    return m;
  }, [results]);

  const ordered = useMemo(
    () => order.map((id) => byId.get(id)).filter((r): r is ResultItem => !!r),
    [order, byId],
  );

  const onDragStart = useCallback((e: React.DragEvent<HTMLElement>, id: string) => {
    dragIdRef.current = id;
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    // 某些浏览器需写入数据才会触发 drag
    try {
      e.dataTransfer.setData("text/plain", id);
    } catch {
      /* ignore */
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>, id: string) => {
    if (!dragIdRef.current || dragIdRef.current === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOverId((cur) => (cur === id ? cur : id));
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLElement>, targetId: string) => {
    e.preventDefault();
    const from = dragIdRef.current;
    if (!from || from === targetId) return;
    setOrder((prev) => moveItem(prev, prev.indexOf(from), prev.indexOf(targetId)));
  }, []);

  const onDragEnd = useCallback(() => {
    dragIdRef.current = null;
    setDragId(null);
    setOverId(null);
  }, []);

  return (
    <div className="create-feed">
      {ordered.map((r) => {
        const dragging = dragId === r.id;
        const dropTarget = overId === r.id && dragId !== r.id;
        return (
          <motion.figure
            className={`create-card${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`}
            key={r.id}
            variants={developVariants}
            initial="initial"
            animate="enter"
            onDragOver={(e) => onDragOver(e, r.id)}
            onDrop={(e) => onDrop(e, r.id)}
          >
            <button
              type="button"
              className="card-drag-handle"
              draggable
              onDragStart={(e) => onDragStart(e, r.id)}
              onDragEnd={onDragEnd}
              aria-label="拖动以重新排序"
              title="拖动排序"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="9" cy="6" r="1.6" />
                <circle cx="15" cy="6" r="1.6" />
                <circle cx="9" cy="12" r="1.6" />
                <circle cx="15" cy="12" r="1.6" />
                <circle cx="9" cy="18" r="1.6" />
                <circle cx="15" cy="18" r="1.6" />
              </svg>
            </button>

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
        );
      })}
    </div>
  );
}
