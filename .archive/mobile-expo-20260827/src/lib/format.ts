/**
 * 展示格式化工具（纯函数）
 */

/** created_at ISO → 人话相对时间（<1m 刚刚 / <1h N 分钟前 / <24h N 小时前 / 否则 M-D） */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}
