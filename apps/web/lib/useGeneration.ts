import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "./friendlyError";
import { trackJob } from "./trackJob";
import type { GenerateResponse } from "./types";
import type { QualityWarning } from "./trackJob";

export type GenerationStatus = "idle" | "running" | "done" | "error";

export interface UseGenerationOptions {
  /** 生成完成回调(此时 resultPaths 已写入,state 已切到 done)。 */
  onDone?: (paths: string[]) => void;
  /** 采样进度回调(SSE progress 事件;仅 max>0 时触发)。 */
  onProgress?: (value: number, max: number) => void;
  /** 生成出错回调(此时 error 已写入,state 已切到 error)。
   *  message 为友好文案(经 friendlyError 包装已知模式);detail 为底层原文(未知模式为 null)。 */
  onError?: (message: string, detail?: string | null) => void;
}

export interface UseGenerationResult {
  status: GenerationStatus;
  progress: { value: number; max: number };
  resultPaths: string[];
  error: string | null;
  /** 底层错误原文(友好文案的「技术详情」;未知模式为 null)。 */
  errorDetail: string | null;
  isRunning: boolean;
  /**
   * 质量评估警告(done 之前若 total < 0.65 后端会推 quality_warning 事件)。
   * null 表示未收到警告或已重置。done 后保留,供结果区上方展示诊断卡片。
   */
  qualityWarning: QualityWarning | null;
  /**
   * 启动一次生成作业。内部调 trackJob,SSE 完成后 resolve。
   * 注意:start 永远 resolve(不会 reject)——出错时通过 onError 回调 + error state 通知。
   * Why:让调用方可以用 try/catch 捕获"前置 API 调用(generateXxx)的异常",
   *     而不必再为 SSE 错误写第二套 catch。
   */
  start: (res: GenerateResponse) => Promise<void>;
  /** 重置为 idle,清空 progress / resultPaths / error / qualityWarning,并关闭未完成的 EventSource。 */
  reset: () => void;
}

/**
 * 收敛各生成视图重复的 SSE 作业跟踪样板。
 *
 * Why:多个视图此前各自 new EventSource + 监听 progress/done/error + useRef 存 es +
 *      卸载清理,逻辑高度重复且容易漏处理边界(如 done 后浏览器补发的空 error)。
 *      本 hook 底层复用 lib/trackJob(已处理上述边界),上层只消费 status/progress/error。
 *
 * 状态机:idle → running → done | error;reset 回到 idle。
 * 进度:trackJob 的 onProgress 回调更新 progress state 并转发给 opts.onProgress。
 * 清理:trackJob 通过 register 暴露 EventSource,本 hook 在卸载时 close。
 *
 * 注:start 接收 GenerateResponse(而非任务模板里的 {sseUrl,client_id,worker}),
 *     因为 trackJob 内部用 jobEventsUrl(res.prompt_id, res.client_id, res.worker)
 *     自行构造 SSE 地址——调用方手里只有 generateXxx() 返回的 GenerateResponse,
 *     直接透传最自然,也避免 prompt_id 缺失导致 URL 拼不出来。
 */
export function useGeneration(opts: UseGenerationOptions = {}): UseGenerationResult {
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [progress, setProgress] = useState<{ value: number; max: number }>({ value: 0, max: 0 });
  const [resultPaths, setResultPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // 质量评估警告:done 前若收到 quality_warning 事件写入;done 后保留供 UI 展示诊断卡片
  const [qualityWarning, setQualityWarning] = useState<QualityWarning | null>(null);

  // 防止卸载后 setState(SSE 回调可能在 unmount 后到达)
  const mountedRef = useRef(true);
  // 持有最新回调,避免 start 闭包捕获过期的 opts
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // 持有当前 EventSource,卸载 / reset 时关闭(trackJob 通过 register 注入)
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const start = useCallback(async (res: GenerateResponse): Promise<void> => {
    // 进入 running 态,清空上次产物 / 错误 / 进度 / 质量警告
    if (mountedRef.current) {
      setStatus("running");
      setProgress({ value: 0, max: 0 });
      setResultPaths([]);
      setError(null);
      setErrorDetail(null);
      setQualityWarning(null);
    }

    try {
      const paths = await trackJob(res, {
        onProgress: (p) => {
          if (!mountedRef.current) return;
          setProgress({ value: p.value, max: p.max });
          optsRef.current.onProgress?.(p.value, p.max);
        },
        onQualityWarning: (warning) => {
          if (!mountedRef.current) return;
          setQualityWarning(warning);
        },
        register: (es) => {
          esRef.current = es;
        },
      });

      if (!mountedRef.current) return;
      setResultPaths(paths);
      setStatus("done");
      optsRef.current.onDone?.(paths);
    } catch (e) {
      if (!mountedRef.current) return;
      const raw = e instanceof Error ? e.message : "生成失败";
      // 走查 P3:底层原文(1011/keepalive/ECONNREFUSED/timeout/5xx)包装为友好文案,原文进 detail
      const { message, detail } = friendlyError(raw);
      setError(message);
      setErrorDetail(detail);
      setStatus("error");
      optsRef.current.onError?.(message, detail);
    }
  }, []);

  const reset = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (!mountedRef.current) return;
    setStatus("idle");
    setProgress({ value: 0, max: 0 });
    setResultPaths([]);
    setError(null);
    setErrorDetail(null);
    setQualityWarning(null);
  }, []);

  return {
    status,
    progress,
    resultPaths,
    error,
    errorDetail,
    isRunning: status === "running",
    qualityWarning,
    start,
    reset,
  };
}
