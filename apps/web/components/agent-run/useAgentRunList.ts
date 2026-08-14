"use client";

/**
 * Agent Team 列表页状态管理(useAgentRunList):
 * - runs:历史 run 卡片列表(状态徽章 + 任务进度 done/total);
 * - create:一句话目标 → 秒回。L0 直链(不跳转,返回 kind:"l0" 由页面提示并链到
 *   对话工作台);L1/L2 返回 runId,页面跳转详情页进计划确认门。
 * - 失败透出 error 条,禁止静默。
 *
 * 注:仅用 useState/useCallback/useEffect,兼容 tests/helpers/renderHook 极简渲染器。
 */
import { useCallback, useEffect, useState } from "react";
import {
  createAgentRun,
  listAgentRuns,
  type AgentRunSummary,
} from "@/lib/api";

/** 创建结果:l0 = 直链工作台(不跳转);run = 跳详情页。 */
export interface CreateOutcome {
  kind: "l0" | "run";
  ack: string;
  runId: string | null;
}

export function useAgentRunList() {
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** L0 秒回提示(页面展示并给工作台链接)。 */
  const [l0Ack, setL0Ack] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await listAgentRuns({ limit: 50 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载任务列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const clearError = useCallback(() => setError(null), []);
  const clearL0Ack = useCallback(() => setL0Ack(null), []);

  /** 创建 Agent 任务;失败返回 null(error 已透出)。 */
  const create = useCallback(async (goal: string): Promise<CreateOutcome | null> => {
    const trimmed = goal.trim();
    if (!trimmed) {
      setError("先用一句话描述你的需求");
      return null;
    }
    setCreating(true);
    setError(null);
    setL0Ack(null);
    try {
      const res = await createAgentRun({ goal: trimmed });
      // L0(或后端判定直链):不跳详情,提示并链到对话工作台
      if (res.level === "L0" || !res.run_id) {
        setL0Ack(res.ack || "已收到,正在为你直连对话工作台");
        return { kind: "l0", ack: res.ack, runId: null };
      }
      return { kind: "run", ack: res.ack, runId: res.run_id };
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建任务失败");
      return null;
    } finally {
      setCreating(false);
    }
  }, []);

  return { runs, loading, creating, error, l0Ack, reload, create, clearError, clearL0Ack };
}
