import { jobEventsUrl } from "./api";
import type { GenerateResponse } from "./types";

/** SSE 透传的采样进度(value/max 来自 ComfyUI,pct 为派生百分比)。 */
export interface JobProgress {
  value: number;
  max: number;
  /** 0-100 整数。 */
  pct: number;
}

export interface TrackJobOptions {
  /** 采样进度回调(SSE `progress` 事件;仅 max>0 时触发)。 */
  onProgress?: (p: JobProgress) => void;
  /**
   * 暴露内部 EventSource 供调用方在组件卸载时清理:
   * 创建后以 es 调用一次,结束(done/error)后以 null 再调一次。
   */
  register?: (es: EventSource | null) => void;
}

/**
 * 统一跟踪一个 ComfyUI 作业:监听后端 SSE 的 progress / done / error。
 *
 * 后端 `/api/jobs/{id}/events` 已把 ComfyUI WebSocket 的 `progress`
 * (采样步数 value/max)转发为 SSE —— 此前各工作台只接 done/error,
 * 白白浪费了真实进度。本 helper 收敛该范式,让所有作业都能拿到真进度。
 *
 * @returns 完成时 resolve 产物的原始相对路径数组(未过 imageUrl);
 *          出错 / 连接中断时 reject(Error)。
 */
export function trackJob(
  res: GenerateResponse,
  opts: TrackJobOptions = {},
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
    opts.register?.(es);
    let done = false;

    const close = () => {
      es.close();
      opts.register?.(null);
    };

    es.addEventListener("progress", (e) => {
      if (!opts.onProgress) return;
      try {
        const d = JSON.parse((e as MessageEvent).data);
        if (d.max > 0) {
          opts.onProgress({
            value: d.value ?? 0,
            max: d.max,
            pct: Math.min(100, Math.round(((d.value ?? 0) / d.max) * 100)),
          });
        }
      } catch {
        /* 忽略畸形分片 */
      }
    });

    es.addEventListener("done", (e) => {
      done = true;
      let paths: string[] = [];
      try {
        paths = (JSON.parse((e as MessageEvent).data).images as string[]) ?? [];
      } catch {
        /* 忽略 */
      }
      close();
      resolve(paths);
    });

    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      // 正常结束后浏览器对已关闭连接补发的空 error 事件 → 忽略
      if (!data && done) return;
      close();
      let msg = "与服务器连接中断";
      if (data) {
        try {
          msg = JSON.parse(data).message ?? "生成出错";
        } catch {
          msg = "生成出错";
        }
      }
      reject(new Error(msg));
    });
  });
}
