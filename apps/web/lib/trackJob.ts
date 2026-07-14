import { jobEventsUrl } from "./api";
import type { GenerateResponse } from "./types";

/** SSE 透传的采样进度(value/max 来自 ComfyUI,pct 为派生百分比)。 */
export interface JobProgress {
  value: number;
  max: number;
  /** 0-100 整数。 */
  pct: number;
}

/**
 * 视频质量评估警告(SSE `quality_warning` 事件)。
 *
 * Why:后端在 done 之前会跑质量评估模型,当 total < 0.65 时推此事件,
 *      让前端能展示三段式评分(美学/技术/对齐)+ 问题清单 + 建议提示词,
 *      给用户"为什么这次出片不理想 / 如何改进"的可操作反馈。
 *
 * degraded=true 表示评估模型自身失败(全 0 / 超时),此时 issues 与
 * suggested_prompt 可能为空,前端要降级展示(只提示"评估降级")。
 */
export interface QualityWarning {
  /** 综合分(0-1)。 */
  total: number;
  /** 综合分(0-100 整数,便于 UI 展示)。 */
  quality_score: number;
  /** 美学维度(0-1)。 */
  aesthetic: number;
  /** 技术维度(0-1,分辨率/帧率/锐度等)。 */
  technical: number;
  /** 提示词对齐度(0-1)。 */
  prompt_alignment: number;
  /** 检测到的问题清单(中文短句)。 */
  issues: string[];
  /** 建议的提示词(可直接预填到正向框);degraded 时可能为 null。 */
  suggested_prompt: string | null;
  /** 评估模型自身失败(降级模式)。 */
  degraded: boolean;
}

export interface TrackJobOptions {
  /** 采样进度回调(SSE `progress` 事件;仅 max>0 时触发)。 */
  onProgress?: (p: JobProgress) => void;
  /**
   * 质量评估警告回调(SSE `quality_warning` 事件)。
   * 在 done 之前触发;不阻塞 done。degraded=true 表示评估模型失败。
   */
  onQualityWarning?: (warning: QualityWarning) => void;
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

    // 质量评估警告:后端在 done 之前推 quality_warning(total < 0.65 时)
    // Why 放在 done 监听之前:此事件只是通知,不阻塞 done 的 resolve 流程;
    //     解析失败时静默忽略,避免影响主作业跟踪
    es.addEventListener("quality_warning", (e) => {
      if (!opts.onQualityWarning) return;
      try {
        const warning = JSON.parse((e as MessageEvent).data) as QualityWarning;
        opts.onQualityWarning(warning);
      } catch {
        /* 解析失败忽略,不阻断 done */
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
