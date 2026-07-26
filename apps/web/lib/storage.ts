/**
 * 轻量 localStorage JSON 封装(SSR 安全 + 静默降级)。
 *
 * 用于 Drama Studio 任务中心(taskLog)等需要跨刷新持久化的前端状态。
 * 设计要点:
 *   - SSR 安全:`typeof window === "undefined"` 时直接返回 fallback,不访问 localStorage
 *   - 静默降级:隐私模式/配额超限/JSON 解析失败均 try/catch 吞掉,不阻断业务
 *   - 无依赖:不引入 zustand 持久化中间件,保持零额外包体积
 */

/** 从 localStorage 读取 JSON,失败返回 fallback。 */
export function loadJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 将 value 序列化写入 localStorage,失败静默忽略。 */
export function saveJSON<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota exceeded / privacy mode:静默降级,功能不阻断
  }
}

/** 删除指定 key(若存在)。 */
export function removeJSON(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 静默
  }
}
