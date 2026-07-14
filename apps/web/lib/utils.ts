/** 时间格式化:秒 → "MM:SS" 或 "HH:MM:SS" */
export function formatTime(sec: number): string {
  if (!sec || sec < 0 || !Number.isFinite(sec)) return "00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 文件大小格式化:字节 → "1.2 MB" */
export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** 防抖 */
export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

/** 节流 */
export function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let last = 0;
  return ((...args: any[]) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  }) as T;
}

/** URL 协议白名单校验(防 javascript: XSS) */
export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 数值范围 clamp */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 数组求 min/max(reduce 版,避免栈溢出) */
export function safeMin(pts: number[]): number {
  return pts.reduce((a, b) => Math.min(a, b), pts[0] ?? 0);
}
export function safeMax(pts: number[]): number {
  return pts.reduce((a, b) => Math.max(a, b), pts[0] ?? 0);
}
