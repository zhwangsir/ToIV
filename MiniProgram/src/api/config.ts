/**
 * API 基址运行时解析（对齐 Mobile lib/config.ts）
 * 优先级：用户覆盖（设置页） > 环境变量 VITE_API_BASE > 默认生产值
 */
export const DEFAULT_API_BASE = 'http://192.168.71.47:8090';

let apiBaseOverride: string | null = null;

/** 由设置 Store 在变更/恢复时调用，注入用户覆盖值 */
export function setApiBaseOverride(value: string | null): void {
  apiBaseOverride = value && value.trim().length > 0 ? value.trim() : null;
}

export function resolveApiBase(): string {
  const fromEnv = import.meta.env.VITE_API_BASE as string | undefined;
  return apiBaseOverride ?? fromEnv ?? DEFAULT_API_BASE;
}

/**
 * 生产防呆：非 dev 构建出现 loopback 地址即视为配置事故
 * @returns 合法返回 true；不合法返回 false 并给出告警
 */
export function assertApiBaseSane(base: string, isDev: boolean): boolean {
  if (isDev) return true;
  const loopback = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/;
  if (loopback.test(base)) {
    console.warn(`[config] 非开发构建使用了回环 API 地址: ${base}`);
    return false;
  }
  return true;
}
