import Constants from 'expo-constants';

/**
 * API 基址运行时解析（吸取 Web 端构建期烘焙教训，见 docs/development-standards.md 3.3）
 * 优先级：用户覆盖（设置页） > app.json extra.apiBase > 默认生产值
 */
export const DEFAULT_API_BASE = 'http://192.168.71.47:8090';

let apiBaseOverride: string | null = null;

/** 由设置 Store 在变更/水合时调用，注入用户覆盖值 */
export function setApiBaseOverride(value: string | null): void {
  apiBaseOverride = value && value.trim().length > 0 ? value.trim() : null;
}

export function resolveApiBase(): string {
  const fromExtra = (Constants.expoConfig?.extra as { apiBase?: string } | undefined)
    ?.apiBase;
  return apiBaseOverride ?? fromExtra ?? DEFAULT_API_BASE;
}

/**
 * 生产防呆：非 dev 构建出现 loopback 地址即视为配置事故（对齐 deploy.sh 防呆精神）
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
