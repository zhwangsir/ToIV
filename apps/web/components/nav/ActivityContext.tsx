"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * 灵动岛实时活动 —— 轻量全局上下文。
 * 创作/画布/漫剧等域在生成过程中向此推送进度,灵动岛据此长大成 live activity。
 * 单一真相:同一时刻只表达一条活跃任务(后来者覆盖前者)。
 */

/** 活动种类 —— 复用创作台 Mode 语义(图像/视频/3D/音频)+ 漫剧/画布扩展位。 */
export type ActivityKind = "image" | "video" | "model3d" | "audio" | "canvas" | "manju";

/** 活动阶段 —— 驱动灵动岛的形变与脉冲收尾。 */
export type ActivityPhase = "running" | "done" | "error";

export interface Activity {
  kind: ActivityKind;
  /** 人类可读标签(常为提示词截断);UI 侧再做省略。 */
  label: string;
  /** 真实进度数值;与 max 配合算百分比。null = 不确定态(走流动条)。 */
  value: number | null;
  /** 进度上限(如总采样步数 / 总镜数)。null/0 = 不确定态。 */
  max: number | null;
  phase: ActivityPhase;
  /** 可选:分镜进度的「镜 x/y」展示(漫剧用),与百分比二选一。 */
  shot?: { index: number; total: number };
}

export interface ActivityContextValue {
  activity: Activity | null;
  setActivity: (next: Activity) => void;
  clearActivity: () => void;
}

const ActivityContext = createContext<ActivityContextValue | null>(null);

export function ActivityProvider({ children }: { children: ReactNode }) {
  const [activity, setActivityState] = useState<Activity | null>(null);

  const setActivity = useCallback((next: Activity) => {
    // 不可变:始终以新对象替换,绝不就地修改。
    setActivityState({ ...next });
  }, []);

  const clearActivity = useCallback(() => {
    setActivityState(null);
  }, []);

  const value = useMemo<ActivityContextValue>(
    () => ({ activity, setActivity, clearActivity }),
    [activity, setActivity, clearActivity],
  );

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

/**
 * 读取活动上下文。
 * - 在 Provider 之外调用会显式抛错,避免静默拿到 null 造成难排查的运行时异常。
 */
export function useActivity(): ActivityContextValue {
  const ctx = useContext(ActivityContext);
  if (!ctx) {
    throw new Error("useActivity 必须在 <ActivityProvider> 内使用");
  }
  return ctx;
}
