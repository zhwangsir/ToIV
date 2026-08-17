/**
 * 展示格式化工具
 */
import type { JobStatus } from '@/types/api';

/** ISO 时间 → 本地 YYYY-MM-DD HH:mm */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 时间 → 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前，超 7 天走绝对日期） */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, now - t);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDateTime(iso).slice(0, 10);
}

export interface JobStatusMeta {
  label: string;
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

const STATUS_META: Record<JobStatus, JobStatusMeta> = {
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '生成中', tone: 'warning' },
  done: { label: '已完成', tone: 'success' },
  error: { label: '失败', tone: 'danger' },
};

/** 作业状态 → 中文标签 + 语义色 */
export function jobStatusMeta(status: JobStatus): JobStatusMeta {
  return STATUS_META[status] ?? { label: status, tone: 'neutral' };
}

/** 是否为终态（终态停止轮询） */
export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'done' || status === 'error';
}

/** 是否为活跃态（queued/running 驱动列表轮询，对齐 Mobile hasActiveJobs） */
export function isActiveStatus(status: JobStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** 列表中是否还有活跃作业（有则继续 2s 轮询，全部终态即停）
 *  裁切链进行中(done 但 post_status=processing)同样视为活跃:
 *  停轮询会导致「精确裁切中」永远等不到终产物回写 */
export function hasActiveJobs(
  jobs: ReadonlyArray<{ status: JobStatus; post_status?: string }>,
): boolean {
  return jobs.some((j) => isActiveStatus(j.status) || j.post_status === 'processing');
}
