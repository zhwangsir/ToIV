"use client";

/**
 * 全局生成进度条(数据来自 lib/generationBus)。
 *
 * 视觉克制原则:顶部 3px 细条 + 右上角小胶囊,不遮挡内容、不闪烁;
 * 填充色 var(--accent)(与 --run 同系),样式全部走 token(effects.css)。
 *
 * 呈现规则:
 *   - 有确定进度任务 → 条宽 = 确定任务 pct 均值(过渡动画);
 *   - 全部不确定(排队/轮询类)→ 40% 宽滑动动画(reduced-motion 降级为静态填充);
 *   - 胶囊:单任务显示 `label pct%`(或不确定态 `label…`),多任务显示 `N 项生成中`;
 *   - 无任务时不渲染。
 */
import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe, type GenTask } from "@/lib/generationBus";

/** 服务端/空态快照(模块级常量,保证 getServerSnapshot 返回稳定引用)。 */
const EMPTY_TASKS: GenTask[] = [];

export interface GenSummary {
  /** 是否存在确定进度任务(决定条宽模式:均值 vs 不确定滑动)。 */
  determinate: boolean;
  /** 确定任务 pct 均值(0-100 整数);无确定任务为 null。 */
  avg: number | null;
  /** 胶囊文案。 */
  pillText: string;
}

/** 任务列表 → 呈现派生态(纯函数,供 GlobalProgressView 与单测共用)。 */
export function summarizeTasks(tasks: GenTask[]): GenSummary {
  const det = tasks.filter((t) => t.pct !== null);
  const determinate = det.length > 0;
  const avg = determinate
    ? Math.round(det.reduce((sum, t) => sum + (t.pct ?? 0), 0) / det.length)
    : null;
  const single = tasks.length === 1 ? tasks[0] : null;
  const pillText = single
    ? single.pct !== null
      ? `${single.label} ${single.pct}%`
      : `${single.label}…`
    : `${tasks.length} 项生成中`;
  return { determinate, avg, pillText };
}

/** 纯展示层(无订阅逻辑,renderToStaticMarkup 可直接测)。 */
export function GlobalProgressView({ tasks }: { tasks: GenTask[] }) {
  if (tasks.length === 0) return null;
  const { determinate, avg, pillText } = summarizeTasks(tasks);
  return (
    <>
      <div
        className="global-progress"
        role="progressbar"
        aria-label="全局生成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(avg !== null ? { "aria-valuenow": avg } : {})}
      >
        <div
          className={`global-progress-fill${determinate ? "" : " is-indeterminate"}`}
          style={avg !== null ? { width: `${avg}%` } : undefined}
        />
      </div>
      {/* 胶囊为进度条的冗余装饰,对读屏隐藏(进度语义已由 progressbar 承担) */}
      <div className="global-progress-pill" aria-hidden="true">
        {pillText}
      </div>
    </>
  );
}

export function GlobalProgress() {
  const tasks = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_TASKS);
  return <GlobalProgressView tasks={tasks} />;
}
