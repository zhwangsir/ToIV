import {
  SESSION_EXPIRED_EVENT,
  apiFetch,
  authHeaders,
  emitSessionExpired,
  jobEventsUrl,
} from "./api";
import {
  begin as busBegin,
  end as busEnd,
  progress as busProgress,
} from "./generationBus";
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
  /** 全局进度条任务文案(引擎显示名/操作名);缺省「生成」。 */
  label?: string;
  /**
   * 质量评估警告回调(SSE `quality_warning` 事件)。
   * 在 done 之前触发;不阻塞 done。degraded=true 表示评估模型失败。
   */
  onQualityWarning?: (warning: QualityWarning) => void;
  /**
   * 时长后处理通知(done 事件/轮询对账时 post_status=processing):
   * trim/extend 裁切链仍在后台跑,本次 resolve 的 paths 是未裁原片;
   * 调用方应显示「精确裁切中」并轮询终产物。在 resolve 之前触发一次。
   */
  onPostProcessing?: () => void;
  /**
   * 暴露内部 EventSource 供调用方在组件卸载时清理:
   * 创建后以 es 调用一次(每次断线重建都会重新暴露),
   * 结束(done/error/超时)后以 null 再调一次。
   */
  register?: (es: EventSource | null) => void;
  /**
   * SSE 网络断线进入重连时回调(attempt 从 1 开始),
   * 供 UI 展示"连接中断,重连中";重连成功(open)后不再触发。
   * 注:看门狗判假死后的软重连不触发此回调(不计失败,见看门狗注释)。
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
  /**
   * 看门狗阈值(ms,默认 60000):SSE 连接建立后超过此时长无任何事件
   * (open/progress/quality_warning 均会刷新计时)判定连接假死,主动断开重连。
   * 取值决策见 trackJob 文档注释「看门狗」节;测试可缩放。
   */
  watchdogMs?: number;
}

/** FSM 2.0 显式状态(迁移表见 trackJob 文档注释)。 */
type TrackState =
  | "connecting" // 连接已发起,尚未收到 open
  | "streaming" // SSE 已 open,正常接收事件
  | "reconnecting" // 断线后的退避等待 / 重连进行中
  | "polling" // 连续重连失败,降级 GET /api/jobs 轮询对账
  | "done" // 终态:拿到产物路径,resolve
  | "error" // 终态:业务错误 / 轮询确认失败 / 冷启动鉴权失败 / 总超时,reject
  | "aborted"; // 终态:会话失效(全局 401/登出广播)显式关流,reject

/** 看门狗默认阈值(ms);取值决策见 trackJob 文档注释。 */
const DEFAULT_WATCHDOG_MS = 60_000;
/** 重连快照窗(ms):重连 open 后窗口期内与断线前末帧负载相同的事件判为回放重复,丢弃。 */
const SNAPSHOT_WINDOW_MS = 500;
/** 冷启动失败从第几次连续失败起介入鉴权探针(首次瞬抖直接退避,不额外发请求)。 */
const COLD_START_PROBE_AFTER = 2;

/**
 * 统一跟踪一个 ComfyUI 作业:监听后端 SSE 的 progress / done / error。
 *
 * 后端 `/api/jobs/{id}/events` 已把 ComfyUI WebSocket 的 `progress`
 * (采样步数 value/max)转发为 SSE —— 此前各工作台只接 done/error,
 * 白白浪费了真实进度。本 helper 收敛该范式,让所有作业都能拿到真进度。
 *
 * FSM 2.0 断线容错状态机(弱网/跨境抖动下作业仍在后端跑,不能误判失败):
 *
 *   状态迁移表(当前态 --事件--> 次态):
 *     connecting   --open----------------------------> streaming(everConnected 置位)
 *     connecting   --网络 error / 看门狗-------------> reconnecting(记 1 次连续失败;
 *                                                     冷启动连续失败先探针分级:401/403 → error)
 *     streaming    --done----------------------------> done
 *     streaming    --业务 error(带 data)------------> error(立即 reject,不重连)
 *     streaming    --网络 error----------------------> reconnecting
 *     streaming    --看门狗静默超时-------------------> 软重连(立即重建,不计失败、
 *                                                     不触发 onReconnecting;armed 快照窗)
 *     reconnecting --open----------------------------> streaming(失败计数清零,armed 快照窗)
 *     reconnecting --网络 error / 看门狗-------------> reconnecting(退避升级)
 *                                                  | polling(连续失败达上限)
 *     polling      --查到 done-----------------------> done
 *     polling      --查到 error----------------------> error
 *     polling      --401(apiFetch 全局处理广播)------> aborted
 *     any          --SESSION_EXPIRED_EVENT-----------> aborted(显式关流)
 *     any          --总超时---------------------------> error
 *
 * 四项工程化能力(参照 DramaClaw stream-client,按 ToIV 适配):
 *
 * 1. 看门狗(判假死主动重连):
 *    后端 /api/jobs/{id}/events 无应用层心跳 —— jobs.py 只 yield
 *    progress / quality_warning / done / error 四种事件;sse-starlette 默认
 *    15s ping 是 SSE 注释行(`: ping`),按 SSE 规范 EventSource 对注释行
 *    不派发事件,JS 侧完全不可见,故看门狗只能以「业务事件间隔」度量。
 *    阈值 60s 决策依据:正常静默上界 = 视频作业 done 前 VideoScorer 质量评估
 *    (jobs.py wait_for 30s 封顶)+ 节点执行间隙(秒级)→ 60s 覆盖最坏正常
 *    尾部静默;更长的静默只剩 ① 真·假死(代理半开/僵尸连接,必须重连)
 *    ② 排队等待/冷载模型(分钟级)——此时软重连对后端无副作用(stream() 重入
 *    仅重挂同一 client_id 的 ComfyUI WS),代价是排队期间至多每分钟一次无害
 *    重建。软重连不计入连续失败、不触发 onReconnecting,避免健康长静默
 *    引发 UI「重连中」抖动;若重建本身失败(真断网),error 事件会走正常
 *    退避/降级路径。connecting/reconnecting 阶段 open 迟迟不到则视为连接
 *    失败,计入退避。
 *
 * 2. 重连快照窗(500ms 去重):
 *    重连 open 后服务端可能重推断线前状态(典型:done 前的 quality_warning
 *    会随重连的 get_result_files 竞态路径被重算重推)。窗口期内与断线前
 *    最后一帧负载完全相同的 progress / quality_warning 判为回放重复,丢弃,
 *    防 UI 进度回跳/重复 toast;新负载正常透传。done 由 settled 幂等天然免疫。
 *
 * 3. 冷启动失败分级:
 *    EventSource 拿不到 HTTP 状态码,连接最初建立阶段(从未 open 过)连续
 *    失败时,借同鉴权语义的轻量端点(/api/jobs?limit=1,skipAuthRedirect)
 *    探针分级:401/403 = 凭据无效 → 立即终止报鉴权错误并广播会话失效,
 *    不再重连/降级空转;其他(5xx/网络异常/探针自身失败)= 网络抖动 →
 *    维持既有指数退避 + 超限降级轮询。首次失败不探针(瞬抖概率高,
 *    直接退避,避免每次抖动多一次请求)。
 *
 * 4. 会话失效显式关流:
 *    监听 window 的 SESSION_EXPIRED_EVENT(apiFetch 401 统一处理 / 本模块
 *    冷启动探针确认凭据无效时广播),收到后立即关闭 EventSource、清全部
 *    定时器并以鉴权错误 reject(state=aborted),杜绝持失效凭据空转重连。
 *
 * 只有带 data 的业务 error 事件(后端 JSON {message})才立即 reject。
 *
 * @returns 完成时 resolve 产物的原始相对路径数组(未过 imageUrl);
 *          业务出错 / 轮询确认失败 / 鉴权失效 / 总超时时 reject(Error)。
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
    const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;

    // 全局进度条:进入即登记(排队期 indeterminate),首个 max>0 进度事件起转确定
    // 百分比;cleanup 统一 end(done/error/超时/会话失效/轮询终态全覆盖),
    // 重连/降级轮询期间任务保留不清除。
    const busId = res.prompt_id || `job-${Date.now()}`;
    busBegin(busId, opts.label ?? "生成");

    let state: TrackState = "connecting";
    let es: EventSource | null = null;
    let settled = false;
    let reconnectAttempt = 0;
    /** 冷启动分级标记:整个跟踪周期内是否曾成功 open(曾成功 = 凭据有效过,
     *  后续失败一律按网络抖动处理,不再探针)。 */
    let everConnected = false;
    let authProbeInFlight = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    /** 重连快照窗截止时刻(Date.now());0 = 不在窗口期。 */
    let snapshotUntil = 0;
    /** 断线前最后转发的 progress / quality_warning 原始负载(回放去重基准)。 */
    let lastProgressSig: string | null = null;
    let lastWarningSig: string | null = null;

    const setState = (next: TrackState): void => {
      state = next;
    };

    const closeEs = (): void => {
      if (es) {
        es.close();
        es = null;
        opts.register?.(null);
      }
    };
    const clearWatchdog = (): void => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    /** 终态收尾:关连接、清定时器、摘会话监听、向调用方交还 EventSource 句柄。 */
    const cleanup = (): void => {
      busEnd(busId);
      closeEs();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearTimeout(pollTimer);
      clearWatchdog();
      clearTimeout(totalTimer);
      if (typeof window !== "undefined") {
        window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
      }
      opts.register?.(null);
    };
    const finishOk = (paths: string[]): void => {
      if (settled) return;
      settled = true;
      setState("done");
      cleanup();
      resolve(paths);
    };
    const finishErr = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (state !== "aborted") setState("error"); // aborted 语义优先(显式关流)
      cleanup();
      reject(err);
    };

    // 总超时兜底:SSE 长挂 / 轮询一直查不到作业时也必须 settle
    const totalTimer = setTimeout(() => {
      finishErr(new Error("作业跟踪超时,请在作品库查看结果"));
    }, timeoutMs);

    /** 会话失效(全局登出/401 广播):立即关流终止,不再重连/轮询。 */
    const onSessionExpired = (): void => {
      if (settled) return;
      setState("aborted");
      finishErr(new Error("登录状态已失效,请重新登录"));
    };

    /** 看门狗计时:任何业务事件到达 = 连接存活,刷新计时。 */
    const armWatchdog = (): void => {
      clearWatchdog();
      watchdogTimer = setTimeout(onWatchdog, watchdogMs);
    };

    /** 看门狗触发:streaming 判假死软重连;连接建立期挂死按连接失败计入退避。 */
    const onWatchdog = (): void => {
      watchdogTimer = null;
      if (settled) return;
      if (state === "streaming") {
        // 软重连:不计失败、不回调 onReconnecting、立即重建(理由见头注释第 1 条)
        closeEs();
        connect();
        return;
      }
      onNetworkDrop();
    };

    /**
     * 冷启动失败分级探针:EventSource 无法拿到 HTTP 状态码,借同鉴权语义的
     * 轻量端点区分「凭据无效」与「网络抖动」。skipAuthRedirect:401/403 由本
     * 模块自行终止并广播会话失效,不触发全局跳转(跳转留给用户下一次交互时
     * 的统一 401 处理)。
     */
    const probeAuth = async (): Promise<"auth" | "jitter"> => {
      try {
        const r = await apiFetch(
          `/api/jobs?limit=1`,
          { headers: authHeaders() },
          { skipAuthRedirect: true, timeoutMs: 10_000 },
        );
        return r.status === 401 || r.status === 403 ? "auth" : "jitter";
      } catch {
        return "jitter"; // 探针自身失败恰是网络抖动证据,维持退避
      }
    };

    /** 网络断线处理:关旧连接 → (冷启动连续失败先探针分级) → 指数退避重连;连续失败超限 → 降级轮询。 */
    const onNetworkDrop = (): void => {
      if (settled) return;
      clearWatchdog();
      closeEs();
      if (reconnectAttempt >= maxReconnect) {
        startPolling();
        return;
      }
      reconnectAttempt += 1;
      setState("reconnecting");
      opts.onReconnecting?.(reconnectAttempt);
      // 指数退避:1s / 2s / 4s / 8s,封顶 10s(reconnectBaseMs 可缩放,测试用)
      const wait = Math.min(10_000, baseMs * 2 ** (reconnectAttempt - 1));
      if (!everConnected && reconnectAttempt >= COLD_START_PROBE_AFTER && !authProbeInFlight) {
        authProbeInFlight = true;
        void probeAuth().then((verdict) => {
          authProbeInFlight = false;
          if (settled) return;
          if (verdict === "auth") {
            // 凭据无效:立即终止报鉴权错误,不重连不降级;
            // 广播会话失效,让其他在途 trackJob 一并关流
            finishErr(new Error("登录状态已失效,请重新登录"));
            emitSessionExpired();
            return;
          }
          reconnectTimer = setTimeout(connect, wait);
        });
        return;
      }
      reconnectTimer = setTimeout(connect, wait);
    };

    /** 降级轮询:经作品列表端点按 prompt_id 对账作业终态。 */
    const pollTick = async (): Promise<void> => {
      if (settled) return;
      try {
        // authHeaders 在 R18 上下文自动携带 X-NSFW,与 /api/jobs 的
        // nsfw 过滤语义一致;查不到该 prompt_id 一律视为"仍在跑",继续轮询。
        // 注:此处 401 会触发 apiFetch 全局处理 → 广播 SESSION_EXPIRED_EVENT
        // → onSessionExpired 关流终止,无需在此特判。
        const listRes = await apiFetch(`/api/jobs?limit=200`, { headers: authHeaders() });
        if (listRes.ok) {
          const jobs = (await listRes.json()) as JobItem[];
          const job = jobs.find((j) => j.prompt_id === res.prompt_id);
          if (job?.status === "done") {
            // 轮询对账同样可能撞上裁切链窗口期(post_status 由 /api/jobs 透出)
            if (job.post_status === "processing") opts.onPostProcessing?.();
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
      if (settled) return; // await 期间可能已 settle(会话失效/超时),不再排下轮
      pollTimer = setTimeout(() => void pollTick(), pollIntervalMs);
    };
    const startPolling = (): void => {
      if (settled) return;
      clearWatchdog(); // 看门狗只管 SSE;轮询以 apiFetch 超时自约束
      setState("polling");
      void pollTick();
    };

    /** 建立(或重建)SSE 连接并挂事件监听;每次重建都重新 register 暴露。 */
    function connect(): void {
      if (settled) return;
      // 防泄漏:任何重入路径(软重连/退避定时器)都先关旧连接
      closeEs();
      es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
      opts.register?.(es);
      armWatchdog(); // open 迟迟不到也由看门狗兜底(connecting 挂死判连接失败)

      // 连接恢复 → 重连计数清零(「连续失败」语义)
      es.addEventListener("open", () => {
        const isReopen = everConnected;
        reconnectAttempt = 0;
        everConnected = true;
        setState("streaming");
        // 重连快照窗:重连后服务端可能重推断线前状态,窗口期内同负载事件去重
        if (isReopen) snapshotUntil = Date.now() + SNAPSHOT_WINDOW_MS;
        armWatchdog();
      });

      es.addEventListener("progress", (e) => {
        armWatchdog();
        const sig = (e as MessageEvent).data;
        // 快照窗内与断线前末帧相同 → 回放重复,丢弃(防进度回跳)
        if (Date.now() < snapshotUntil && sig != null && sig === lastProgressSig) return;
        try {
          const d = JSON.parse(sig);
          if (d.max > 0) {
            lastProgressSig = sig ?? null;
            // 全局总线广播不依赖 opts.onProgress:未传回调的调用方也显示真实进度
            // (THEME-INPUT-PROGRESS 二期遗留清零;此前 !onProgress 整体 return,
            // 新调用方只显 indeterminate)
            const pct = Math.min(100, Math.round(((d.value ?? 0) / d.max) * 100));
            busProgress(busId, pct);
            opts.onProgress?.({ value: d.value ?? 0, max: d.max, pct });
          }
        } catch {
          /* 忽略畸形分片 */
        }
      });

      // 质量评估警告:后端在 done 之前推 quality_warning(total < 0.65 时)
      // Why 放在 done 监听之前:此事件只是通知,不阻塞 done 的 resolve 流程;
      //     解析失败时静默忽略,避免影响主作业跟踪
      es.addEventListener("quality_warning", (e) => {
        armWatchdog();
        if (!opts.onQualityWarning) return;
        const sig = (e as MessageEvent).data;
        // 快照窗内与断线前末帧相同 → 回放重复,丢弃(防重复 toast)
        if (Date.now() < snapshotUntil && sig != null && sig === lastWarningSig) return;
        try {
          const warning = JSON.parse(sig) as QualityWarning;
          lastWarningSig = sig ?? null;
          opts.onQualityWarning(warning);
        } catch {
          /* 解析失败忽略,不阻断 done */
        }
      });

      es.addEventListener("done", (e) => {
        let paths: string[] = [];
        let postStatus = "";
        try {
          const payload = JSON.parse((e as MessageEvent).data);
          paths = (payload.images as string[]) ?? [];
          postStatus = (payload.post_status as string) ?? "";
        } catch {
          /* 忽略 */
        }
        // 时长后处理链进行中(trim/extend):paths 为未裁原片,通知调用方转「精确裁切中」
        if (postStatus === "processing") opts.onPostProcessing?.();
        finishOk(paths); // settled 幂等:窗口期回放重复 done 无副作用
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

    // 会话失效显式关流:全局登出 / api 401 统一处理 / 冷启动探针确认凭据无效时广播
    if (typeof window !== "undefined") {
      window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    }
    connect();
  });
}
