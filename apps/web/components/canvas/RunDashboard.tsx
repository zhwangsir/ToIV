"use client";

import { useEffect, useMemo, useState } from "react";
import type { Node } from "@xyflow/react";

import { NODE_META, type CanvasNodeType, type NodeRunState } from "./types";

// 带运行态(会出产物)的节点类型——text/lighting 仅供数据,不进看板。
const HAS_RUN = new Set<string>([
  "image",
  "video",
  "audio",
  "storyboard",
  "character",
  "threed",
  "img2img",
  "controlnet",
  "ipadapter",
  "upscale",
  "facedetailer",
  "removebg",
  "inpaint",
  "rawflow",
]);

interface Row {
  id: string;
  label: string;
  icon: string;
  busy: boolean;
  progress: number | null;
  error: string | null;
  done: boolean;
}

/** CV3 运行反馈:画布级运行看板。运行时浮现,聚合每个可运行节点的 跑/完/错。
 *  节点级进度条已在 NodeShell;此处解决「节点多/缩放小看不全整张图状态」。 */
export function RunDashboard({
  nodes,
  pipelineBusy,
}: {
  nodes: Node[];
  pipelineBusy: boolean;
}) {
  const [hidden, setHidden] = useState(false);

  // 新一轮运行开始,重新展开(用户上次收起的不该永久隐藏)。
  useEffect(() => {
    if (pipelineBusy) setHidden(false);
  }, [pipelineBusy]);

  const rows = useMemo<Row[]>(
    () =>
      nodes
        .filter((n) => n.type && HAS_RUN.has(n.type))
        .map((n) => {
          const run = (n.data as { run?: NodeRunState }).run;
          const meta = NODE_META[n.type as CanvasNodeType];
          return {
            id: n.id,
            label: meta?.label ?? n.type ?? "节点",
            icon: meta?.icon ?? "•",
            busy: !!run?.busy,
            progress: run?.progress ?? null,
            error: run?.error ?? null,
            done: !!run?.outputUrl && !run?.busy,
          };
        }),
    [nodes],
  );

  const anyActive = pipelineBusy || rows.some((r) => r.busy || r.error);
  if (hidden || !anyActive || rows.length === 0) return null;

  const done = rows.filter((r) => r.done).length;
  const errCount = rows.filter((r) => r.error).length;
  const firstErr = rows.find((r) => r.error)?.error ?? null;
  const heading = pipelineBusy ? "运行中" : errCount ? "有节点报错" : "运行完成";

  return (
    <div className="cv-dash" role="status" aria-label="运行看板">
      <header className="cv-dash__head">
        <span className="cv-dash__title">
          {heading}
          <span className="cv-dash__count">
            {done}/{rows.length}
          </span>
        </span>
        <button
          type="button"
          className="cv-dash__close"
          onClick={() => setHidden(true)}
          aria-label="收起看板"
          title="收起"
        >
          ✕
        </button>
      </header>
      <ul className="cv-dash__list">
        {rows.map((r) => (
          <li
            key={r.id}
            className={`cv-dash__row${
              r.error ? " is-err" : r.busy ? " is-run" : r.done ? " is-done" : ""
            }`}
          >
            <span className="cv-dash__ico" aria-hidden="true">
              {r.icon}
            </span>
            <span className="cv-dash__label">{r.label}</span>
            <span className="cv-dash__state">
              {r.error
                ? "❌ 失败"
                : r.busy
                  ? r.progress !== null
                    ? `${r.progress}%`
                    : "…"
                  : r.done
                    ? "✅"
                    : "待运行"}
            </span>
          </li>
        ))}
      </ul>
      {firstErr && <p className="cv-dash__errline">{firstErr}</p>}
    </div>
  );
}
