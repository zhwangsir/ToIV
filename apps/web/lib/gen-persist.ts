"use client";

/**
 * 生成状态浏览器持久化。
 *
 * Why:页面用条件渲染卸载非当前视图,导致切走再切回时:
 *   · 正在进行的 SSE 连接被 close,后端作业仍在跑但前端拿不到结果
 *   · 已生成的结果图片 / 进度 / 种子全部丢失
 *
 * 方案:把"作业 ID + 进度 + 结果 + 关键表单快照"写入 sessionStorage,
 *   组件重新挂载时自动恢复;若作业仍在进行中,自动重连 SSE 继续跟踪。
 *
 * 持久化范围:
 *   · 作业标识(prompt_id / client_id / worker)→ 用于重连 SSE
 *   · 生成状态(status / progress / results / error / lastSeed)
 *   · 质量评估警告(qualityWarning)
 *   · 表单快照(positive / negative / 模型名等)→ 切回后表单不丢
 *
 * 不持久化:
 *   · EventSource 实例(不可序列化,重连时新建)
 *   · 模型列表等列表数据(走 SWR 缓存)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { jobEventsUrl } from "./api";
import { trackJob, type QualityWarning } from "./trackJob";
import type { GenerateResponse } from "./types";

const STORAGE_PREFIX = "toiv_gen_";
const STALE_MS = 30 * 60 * 1000; // 30 分钟后视为过期,不再恢复

/** 可持久化的生成状态(所有字段均可 JSON 序列化)。 */
export interface PersistedGenState {
  /** 作业标识(用于 SSE 重连)。 */
  promptId: string | null;
  clientId: string | null;
  worker: string | null;
  /** 实际使用的 seed(用于"锁定上次种子")。 */
  lastSeed: number | null;
  /** 生成状态:idle | running | done | error。 */
  status: "idle" | "running" | "done" | "error";
  /** 采样进度。 */
  progress: { value: number; max: number };
  /** 产物路径数组(后端相对路径,展示时用 imageUrl 包装)。 */
  resultPaths: string[];
  /** 错误信息。 */
  error: string | null;
  /** 质量评估警告(done 前若 total < 0.65)。 */
  qualityWarning: QualityWarning | null;
  /** 更新时间戳(用于过期判断)。 */
  updatedAt: number;
}

const IDLE_STATE: PersistedGenState = {
  promptId: null,
  clientId: null,
  worker: null,
  lastSeed: null,
  status: "idle",
  progress: { value: 0, max: 0 },
  resultPaths: [],
  error: null,
  qualityWarning: null,
  updatedAt: 0,
};

function storageKey(slot: string): string {
  return `${STORAGE_PREFIX}${slot}`;
}

/** 从 sessionStorage 读取(不存在 / 过期 / 解析失败 → idle)。 */
function readState(slot: string): PersistedGenState {
  if (typeof window === "undefined") return IDLE_STATE;
  try {
    const raw = window.sessionStorage.getItem(storageKey(slot));
    if (!raw) return IDLE_STATE;
    const s = JSON.parse(raw) as PersistedGenState;
    if (!s.updatedAt || Date.now() - s.updatedAt > STALE_MS) return IDLE_STATE;
    return s;
  } catch {
    return IDLE_STATE;
  }
}

/** 写入 sessionStorage。 */
function writeState(slot: string, s: PersistedGenState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(slot), JSON.stringify(s));
  } catch {
    /* sessionStorage 满或禁用,静默降级 */
  }
}

/** 清除 sessionStorage 中的指定 slot。 */
function clearState(slot: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey(slot));
  } catch {
    /* ignore */
  }
}

export interface UsePersistedGenerationOptions {
  /**
   * 持久化槽位名(如 "create" / "nsfw-video")。
   * 不同视图用不同 slot,互不干扰。
   */
  slot: string;
  /** 生成完成回调。 */
  onDone?: (paths: string[]) => void;
  /** 采样进度回调。 */
  onProgress?: (value: number, max: number) => void;
  /** 生成出错回调。 */
  onError?: (message: string) => void;
}

export interface UsePersistedGenerationResult {
  status: PersistedGenState["status"];
  progress: { value: number; max: number };
  resultPaths: string[];
  error: string | null;
  qualityWarning: QualityWarning | null;
  lastSeed: number | null;
  isRunning: boolean;
  /** 启动一次生成作业(传入 generateXxx 返回的 GenerateResponse)。 */
  start: (res: GenerateResponse) => Promise<void>;
  /** 重置为 idle,清空所有产物,并清除 sessionStorage。 */
  reset: () => void;
  /** 仅更新进度(供外部 SSE 回调使用)。 */
  setProgress: (value: number, max: number) => void;
  /** 仅更新状态(供外部状态机使用)。 */
  setStatus: (s: PersistedGenState["status"]) => void;
  /** 写入错误信息并切到 error 态(供前置 API 调用失败时使用)。 */
  setError: (msg: string) => void;
}

/**
 * 持久化生成 hook:状态自动写入 sessionStorage,组件重新挂载时自动恢复。
 *
 * 若恢复时发现作业仍在 running 状态(有 promptId 且未 done/error),
 * 自动重连 SSE 继续跟踪进度。
 *
 * 使用方式与 useGeneration 一致:
 *   const gen = usePersistedGeneration({ slot: "create", onDone: ... });
 *   await gen.start(res);  // res = await generateTxt2img(params)
 */
export function usePersistedGeneration(
  opts: UsePersistedGenerationOptions,
): UsePersistedGenerationResult {
  const { slot } = opts;

  // 初始化:从 sessionStorage 恢复
  const [state, setState] = useState<PersistedGenState>(() => readState(slot));

  // 防止卸载后 setState
  const mountedRef = useRef(true);
  // 持有最新回调
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // 持有当前 EventSource
  const esRef = useRef<EventSource | null>(null);
  // 标记是否需要重连(从 storage 恢复且 status === running 时)
  const reconnectRef = useRef<string | null>(null);

  // 状态更新 + 持久化
  const updateState = useCallback(
    (patch: Partial<PersistedGenState>) => {
      setState((prev) => {
        const next = { ...prev, ...patch, updatedAt: Date.now() };
        writeState(slot, next);
        return next;
      });
    },
    [slot],
  );

  // 挂载:恢复 + 自动重连;卸载:关闭 SSE
  useEffect(() => {
    mountedRef.current = true;
    const restored = readState(slot);
    if (restored.status === "running" && restored.promptId && restored.clientId && restored.worker) {
      // 作业仍在进行中,自动重连 SSE
      reconnectRef.current = restored.promptId;
    }
    return () => {
      mountedRef.current = false;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [slot]);

  // 执行重连(在 useEffect 中延迟执行,确保 mountedRef 已设置)
  useEffect(() => {
    const promptId = reconnectRef.current;
    reconnectRef.current = null;
    if (!promptId) return;

    const restored = readState(slot);
    if (restored.status !== "running" || !restored.promptId || !restored.clientId || !restored.worker) return;

    // 构造伪 GenerateResponse 用于重连
    const fakeRes: GenerateResponse = {
      prompt_id: restored.promptId,
      client_id: restored.clientId,
      worker: restored.worker,
      seed: restored.lastSeed ?? 0,
    };

    // 重连 SSE,但不重新提交作业(只是继续监听进度)
    trackJob(fakeRes, {
      onProgress: (p) => {
        if (!mountedRef.current) return;
        updateState({ progress: { value: p.value, max: p.max } });
        optsRef.current.onProgress?.(p.value, p.max);
      },
      onQualityWarning: (warning) => {
        if (!mountedRef.current) return;
        updateState({ qualityWarning: warning });
      },
      register: (es) => {
        esRef.current = es;
      },
    })
      .then((paths) => {
        if (!mountedRef.current) return;
        updateState({
          status: "done",
          resultPaths: paths,
          progress: { value: 0, max: 0 },
        });
        optsRef.current.onDone?.(paths);
      })
      .catch((e) => {
        if (!mountedRef.current) return;
        const msg = e instanceof Error ? e.message : "生成失败";
        updateState({ status: "error", error: msg });
        optsRef.current.onError?.(msg);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);

  const start = useCallback(async (res: GenerateResponse): Promise<void> => {
    // 进入 running 态,清空上次产物
    updateState({
      status: "running",
      progress: { value: 0, max: 0 },
      resultPaths: [],
      error: null,
      qualityWarning: null,
      promptId: res.prompt_id,
      clientId: res.client_id,
      worker: res.worker,
      lastSeed: res.seed,
    });

    try {
      const paths = await trackJob(res, {
        onProgress: (p) => {
          if (!mountedRef.current) return;
          updateState({ progress: { value: p.value, max: p.max } });
          optsRef.current.onProgress?.(p.value, p.max);
        },
        onQualityWarning: (warning) => {
          if (!mountedRef.current) return;
          updateState({ qualityWarning: warning });
        },
        register: (es) => {
          esRef.current = es;
        },
      });

      if (!mountedRef.current) return;
      updateState({
        status: "done",
        resultPaths: paths,
        progress: { value: 0, max: 0 },
      });
      optsRef.current.onDone?.(paths);
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : "生成失败";
      updateState({ status: "error", error: msg });
      optsRef.current.onError?.(msg);
    }
  }, [updateState]);

  const reset = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (!mountedRef.current) return;
    const fresh = { ...IDLE_STATE, updatedAt: Date.now() };
    setState(fresh);
    clearState(slot);
  }, [slot]);

  const setProgress = useCallback(
    (value: number, max: number) => {
      updateState({ progress: { value, max } });
    },
    [updateState],
  );

  const setStatus = useCallback(
    (s: PersistedGenState["status"]) => {
      updateState({ status: s });
    },
    [updateState],
  );

  const setError = useCallback(
    (msg: string) => {
      updateState({ status: "error", error: msg, progress: { value: 0, max: 0 } });
    },
    [updateState],
  );

  return {
    status: state.status,
    progress: state.progress,
    resultPaths: state.resultPaths,
    error: state.error,
    qualityWarning: state.qualityWarning,
    lastSeed: state.lastSeed,
    isRunning: state.status === "running",
    start,
    reset,
    setProgress,
    setStatus,
    setError,
  };
}

// ── 表单快照持久化(独立于生成状态,用于保存/恢复表单参数)──

/** 从 sessionStorage 读取表单快照。 */
export function readFormSnapshot<T>(slot: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE_PREFIX}form_${slot}`);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 写入表单快照到 sessionStorage。 */
export function writeFormSnapshot<T>(slot: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `${STORAGE_PREFIX}form_${slot}`,
      JSON.stringify(data),
    );
  } catch {
    /* ignore */
  }
}

/** 清除表单快照。 */
export function clearFormSnapshot(slot: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(`${STORAGE_PREFIX}form_${slot}`);
  } catch {
    /* ignore */
  }
}
