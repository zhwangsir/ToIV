import { describe, expect, it } from 'vitest';

import {
  formatDateTime,
  formatRelative,
  hasActiveJobs,
  isActiveStatus,
  isTerminalStatus,
  jobStatusMeta,
} from '@/utils/format';

describe('formatRelative', () => {
  const now = new Date('2026-08-13T12:00:00').getTime();

  it('1 分钟内 → 刚刚', () => {
    expect(formatRelative(new Date(now - 30_000).toISOString(), now)).toBe('刚刚');
  });

  it('分钟级', () => {
    expect(formatRelative(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 分钟前');
  });

  it('小时级', () => {
    expect(formatRelative(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 小时前');
  });

  it('天级', () => {
    expect(formatRelative(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2 天前');
  });

  it('超 7 天走绝对日期', () => {
    const iso = '2026-08-01T08:00:00.000Z';
    expect(formatRelative(iso, now)).toMatch(/^2026-0[78]-\d{2}$/);
  });

  it('非法输入原样返回', () => {
    expect(formatRelative('not-a-date', now)).toBe('not-a-date');
  });
});

describe('formatDateTime', () => {
  it('合法 ISO 输出本地格式', () => {
    expect(formatDateTime('2026-08-13T10:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法输入原样返回', () => {
    expect(formatDateTime('bad')).toBe('bad');
  });
});

describe('jobStatusMeta / isTerminalStatus', () => {
  it('四态映射', () => {
    expect(jobStatusMeta('queued')).toEqual({ label: '排队中', tone: 'neutral' });
    expect(jobStatusMeta('running')).toEqual({ label: '生成中', tone: 'warning' });
    expect(jobStatusMeta('done')).toEqual({ label: '已完成', tone: 'success' });
    expect(jobStatusMeta('error')).toEqual({ label: '失败', tone: 'danger' });
  });

  it('终态判定', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('error')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
  });
});

describe('isActiveStatus / hasActiveJobs', () => {
  it('活跃态判定', () => {
    expect(isActiveStatus('queued')).toBe(true);
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('done')).toBe(false);
    expect(isActiveStatus('error')).toBe(false);
  });

  it('列表有活跃作业才继续轮询', () => {
    expect(hasActiveJobs([])).toBe(false);
    expect(hasActiveJobs([{ status: 'done' }, { status: 'error' }])).toBe(false);
    expect(hasActiveJobs([{ status: 'done' }, { status: 'queued' }])).toBe(true);
    expect(hasActiveJobs([{ status: 'running' }])).toBe(true);
  });

  it('裁切窗口期(done + post_status=processing)保持轮询;清零后停止', () => {
    expect(hasActiveJobs([{ status: 'done', post_status: 'processing' }])).toBe(true);
    expect(hasActiveJobs([{ status: 'done', post_status: '' }])).toBe(false);
    expect(hasActiveJobs([{ status: 'error', post_status: 'processing' }])).toBe(true);
  });
});
