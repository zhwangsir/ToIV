import { apiFetch, authHeaders, jobEventsUrl } from "./api";
import type { GenerateResponse, JobItem } from "./types";

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
   * 创建后以 es 调用一次(每次断线重建都会重新暴露),
   * 结束(done/error/超时)后以 null 再调一次。
   */
  register?: (es: EventSource | null) => void;
  /**
   * SSE 网络断线进入重连时回调(attempt 从 1 开始),
   * 供 UI 展示"连接中断,重连中";重连成功(open)后不再触发。
   */
  onReconnecting?: (attempt: number) => void;
  /** 总跟踪时长上限(ms,默认 35 分钟);超时 reject,防 Promise 永不 settle。 */
  timeoutMs?: number;
  /** 重连退避基数(ms,默认 1000;实际等待 1/2/4/8s…指数翻倍,封顶 10s)。 */
  reconnectBaseMs?: number;
  /** 最大连续重连次数(默认 5);全败后降级为作品列表轮询。 */
  maxReconnectAttempts?: number;
  /** 降级轮询间隔(ms,默认 5000)。 */
  pollIntervalMs?: number;
}

/**
 * 统一跟踪一个 ComfyUI 作业:监听后端 SSE 的 progress / done / error。
 *
 * 后端 `/api/jobs/{id}/events` 已把 ComfyUI WebSocket 的 `progress`
 * (采样步数 value/max)转发为 SSE —— 此前各工作台只接 done/error,
 * 白白浪费了真实进度。本 helper 收敛该范式,让所有作业都能拿到真进度。
 *
 * 断线容错状态机(弱网/跨境抖动下作业仍在后端跑,不能误判失败):
 *   SSE 正常 → 网络断线(无 data 的 error 事件)→ 指数退避重连(最多连续
 *   maxReconnectAttempts 次,open 后计数清零)→ 仍失败 → 降级轮询
 *   `GET /api/jobs?limit=200` 按 prompt_id 对账(done→resolve / error→reject /
 *   查不到或仍在跑→继续轮询,绝不误判失败)→ 全程受 timeoutMs 总超时兜底。
 * 只有带 data 的业务 error 事件(后端 JSON {message})才立即 reject。
 *
 * @returns 完成时 resolve 产物的原始相对路径数组(未过 imageUrl);
 *          业务出错 / 轮询确认失败 / 总超时时 reject(Error)。
 */
export function trackJob(
  res: GenerateResponse,
  opts: TrackJobOptions = {},
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 35 * 60_000;
    const maxReconnect = opts.maxReconnectAttempts ?? 5;
    const baseMs = opts.reconnectBaseMs ?? 1_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;

    let es: EventSource | null = null;
    let settled = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    /** 终态收尾:关连接、清定时器、向调用方交还 EventSource 句柄。 */
    const cleanup = (): void => {
      if (es) {
        es.close();
        es = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearTimeout(pollTimer);
      clearTimeout(totalTimer);
      opts.register?.(null);
    };
    const finishOk = (paths: string[]): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(paths);
    };
    const finishErr = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    // 总超时兜底:SSE 长挂 / 轮询一直查不到作业时也必须 settle
    const totalTimer = setTimeout(() => {
      finishErr(new Error("作业跟踪超时,请在作品库查看结果"));
    }, timeoutMs);

    /** 网络断线处理:关旧连接 → 指数退避重连;连续失败超限 → 降级轮询。 */
    const onNetworkDrop = (): void => {
      if (settled) return;
      if (es) {
        es.close();
        es = null;
        opts.register?.(null);
      }
      if (reconnectAttempt >= maxReconnect) {
        startPolling();
        return;
      }
      reconnectAttempt += 1;
      opts.onReconnecting?.(reconnectAttempt);
      // 指数退避:1s / 2s / 4s / 8s,封顶 10s(reconnectBaseMs 可缩放,测试用)
      const wait = Math.min(10_000, baseMs * 2 ** (reconnectAttempt - 1));
      reconnectTimer = setTimeout(connect, wait);
    };

    /** 降级轮询:经作品列表端点按 prompt_id 对账作业终态。 */
    const pollTick = async (): Promise<void> => {
      if (settled) return;
      try {
        // authHeaders 在 R18 上下文自动携带 X-NSFW,与 /api/jobs 的
        // nsfw 过滤语义一致;查不到该 prompt_id 一律视为"仍在跑",继续轮询
        const listRes = await apiFetch(`/api/jobs?limit=200`, { headers: authHeaders() });
        if (listRes.ok) {
          const jobs = (await listRes.json()) as JobItem[];
          const job = jobs.find((j) => j.prompt_id === res.prompt_id);
          if (job?.status === "done") {
            finishOk(job.results ?? []);
            return;
          }
          if (job?.status === "error") {
            finishErr(new Error("生成出错"));
            return;
          }
        }
      } catch {
        /* 轮询抖动,下轮再试 */
      }
      pollTimer = setTimeout(() => void pollTick(), pollIntervalMs);
    };
    const startPolling = (): void => {
      if (settled) return;
      void pollTick();
    };

    /** 建立(或重建)SSE 连接并挂事件监听;每次重建都重新 register 暴露。 */
    function connect(): void {
      if (settled) return;
      es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
      opts.register?.(es);

      // 连接恢复 → 重连计数清零(「连续失败」语义)
      es.addEventListener("open", () => {
        reconnectAttempt = 0;
      });

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
        let paths: string[] = [];
        try {
          paths = (JSON.parse((e as MessageEvent).data).images as string[]) ?? [];
        } catch {
          /* 忽略 */
        }
        finishOk(paths);
      });

      es.addEventListener("error", (e) => {
        if (settled) return;
        const data = (e as MessageEvent).data;
        // 带 data 的是后端业务 error(JSON {message})→ 立即 reject,不重连
        if (data) {
          let msg = "生成出错";
          try {
            msg = JSON.parse(data).message ?? "生成出错";
          } catch {
            /* 保留默认 */
          }
          finishErr(new Error(msg));
          return;
        }
        // 无 data = 网络层断线(弱网/跨境抖动;作业仍在后端跑)→ 重连而非误判失败
        onNetworkDrop();
      });
    }

    connect();
  });
}
