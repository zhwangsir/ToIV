/**
 * 全局生成任务总线(全局生成进度条数据源)。
 *
 * Why:全站生成入口分散(A 类 ComfyUI 系走 trackJob 真进度;B 类 drama/studio
 *      等轮询/同步 busy 无百分比),各视图局部进度条互不可见——用户在 A 页发
 *      起生成、切到 B 页后完全感知不到任务仍在跑。本模块以极简 pub/sub 收敛
 *      一个「全站生成任务清单」,供 GlobalProgress 顶部细条统一呈现。
 *
 * 设计:
 *   - 模块级 Map 存任务,插入序即快照序;
 *   - getSnapshot 返回缓存数组(仅变更时重建),保证 useSyncExternalStore
 *     拿到稳定引用,不触发无限重渲染;
 *   - begin 幂等:同 id 重复 begin 仅更新 label,不重置 startedAt/pct
 *     (trackJob 软重连/重试不会打断已累计的进度展示);
 *   - pct null = 排队/不确定态(indeterminate);progress() 首次调用后转为
 *     确定百分比;end 移除任务,未接入的 id 一律 no-op(防御终态后迟到事件)。
 *
 * 纯逻辑、无 DOM 依赖,node:test 可直接单测。
 */
export interface GenTask {
  id: string;
  /** 展示文案(引擎名/操作名,如「分镜 #3 视频生成」)。 */
  label: string;
  /** 0-100 整数;null = 不确定态(排队中/无真实进度源)。 */
  pct: number | null;
  startedAt: number;
}

type GenListener = () => void;

const tasks = new Map<string, GenTask>();
const listeners = new Set<GenListener>();
/** 缓存快照:仅任务集变更时重建(稳定引用契约,见头注释)。 */
let snapshot: GenTask[] = [];

function emit(): void {
  snapshot = Array.from(tasks.values());
  for (const fn of listeners) fn();
}

/**
 * 登记一个生成任务。pct 初始 null(indeterminate);
 * opts.determinate=true 时初始 0(调用方确定会有真实进度,如已知队列后必采样)。
 * 同 id 重复调用仅同步 label(幂等,不重置 startedAt/pct)。
 */
export function begin(id: string, label: string, opts?: { determinate?: boolean }): void {
  const prev = tasks.get(id);
  if (prev) {
    if (prev.label !== label) {
      tasks.set(id, { ...prev, label });
      emit();
    }
    return;
  }
  tasks.set(id, {
    id,
    label,
    pct: opts?.determinate ? 0 : null,
    startedAt: Date.now(),
  });
  emit();
}

/** 更新任务百分比(自动取整并夹取 0-100);未知 id 静默忽略。 */
export function progress(id: string, pct: number): void {
  const prev = tasks.get(id);
  if (!prev) return;
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  if (prev.pct === clamped) return;
  tasks.set(id, { ...prev, pct: clamped });
  emit();
}

/** 终态移除任务(done/error/超时/取消);未知 id 静默忽略。 */
export function end(id: string): void {
  if (!tasks.delete(id)) return;
  emit();
}

/** 订阅任务集变更;返回退订函数。 */
export function subscribe(listener: GenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前任务快照(稳定引用:无变更时多次调用返回同一数组)。 */
export function getSnapshot(): GenTask[] {
  return snapshot;
}
