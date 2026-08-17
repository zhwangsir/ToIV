/**
 * 跨端持久化适配（uni.*StorageSync 薄封装）
 * - 小程序/App 端没有 localStorage/SecureStore，统一走 uni storage
 * - token 也走这里（小程序端无 SecureStore 等价物，沙箱内 uni storage 已是最安全选项）
 * - 所有读写 try/catch 兜底：存储不可用（隐私模式/满）不炸应用
 */

export function getString(key: string): string | null {
  try {
    const value = uni.getStorageSync(key);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setString(key: string, value: string): void {
  try {
    uni.setStorageSync(key, value);
  } catch (e) {
    console.error(`[storage] set ${key} failed:`, e);
  }
}

export function remove(key: string): void {
  try {
    uni.removeStorageSync(key);
  } catch {
    // ignore
  }
}

export function getJson<T>(key: string): T | null {
  const raw = getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setJson(key: string, value: unknown): void {
  setString(key, JSON.stringify(value));
}
