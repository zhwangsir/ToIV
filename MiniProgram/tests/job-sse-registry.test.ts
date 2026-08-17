import { beforeEach, describe, expect, it } from 'vitest';

import type { GenerateResponse } from '@/types/api';
import {
  clearJobSseRegistry,
  getJobSseCredentials,
  JOB_SSE_REGISTRY_CAPACITY,
  jobSseRegistrySize,
  registerJobSseCredentials,
  unregisterJobSseCredentials,
} from '@/utils/job-sse-registry';

function makeResponse(promptId: string, clientId = 'c1', worker = 'w1'): GenerateResponse {
  return { prompt_id: promptId, client_id: clientId, worker, seed: 42 };
}

beforeEach(() => {
  clearJobSseRegistry();
});

describe('job-sse-registry（会话内作业 SSE 凭据登记）', () => {
  it('登记后可读取：client_id/worker 映射为 clientId/worker', () => {
    registerJobSseCredentials(makeResponse('p1', 'c-9', 'w-7'));
    expect(getJobSseCredentials('p1')).toEqual({ clientId: 'c-9', worker: 'w-7' });
  });

  it('未登记的 promptId 读取返回 undefined', () => {
    expect(getJobSseCredentials('p-absent')).toBeUndefined();
  });

  it('unregister 清除指定项，其余保留', () => {
    registerJobSseCredentials(makeResponse('p1'));
    registerJobSseCredentials(makeResponse('p2'));
    unregisterJobSseCredentials('p1');
    expect(getJobSseCredentials('p1')).toBeUndefined();
    expect(getJobSseCredentials('p2')).toBeDefined();
  });

  it('clear 清空全部登记', () => {
    registerJobSseCredentials(makeResponse('p1'));
    registerJobSseCredentials(makeResponse('p2'));
    clearJobSseRegistry();
    expect(jobSseRegistrySize()).toBe(0);
    expect(getJobSseCredentials('p1')).toBeUndefined();
  });

  it('重复登记同一 promptId 覆盖凭据且不膨胀', () => {
    registerJobSseCredentials(makeResponse('p1', 'c-old', 'w-old'));
    registerJobSseCredentials(makeResponse('p1', 'c-new', 'w-new'));
    expect(getJobSseCredentials('p1')).toEqual({ clientId: 'c-new', worker: 'w-new' });
    expect(jobSseRegistrySize()).toBe(1);
  });

  it('容量上限：超出容量淘汰最旧登记', () => {
    for (let i = 0; i < JOB_SSE_REGISTRY_CAPACITY + 1; i += 1) {
      registerJobSseCredentials(makeResponse(`p${i}`));
    }
    expect(jobSseRegistrySize()).toBe(JOB_SSE_REGISTRY_CAPACITY);
    expect(getJobSseCredentials('p0')).toBeUndefined(); // 最旧被淘汰
    expect(getJobSseCredentials(`p${JOB_SSE_REGISTRY_CAPACITY}`)).toBeDefined(); // 最新保留
  });

  it('重登记刷新新旧位次：刚重登的旧项不被淘汰', () => {
    for (let i = 0; i < JOB_SSE_REGISTRY_CAPACITY; i += 1) {
      registerJobSseCredentials(makeResponse(`p${i}`));
    }
    // p0 重登 → 变为最新；再登记一个新项应淘汰 p1 而非 p0
    registerJobSseCredentials(makeResponse('p0', 'c-re', 'w-re'));
    registerJobSseCredentials(makeResponse('p-new'));
    expect(getJobSseCredentials('p0')).toEqual({ clientId: 'c-re', worker: 'w-re' });
    expect(getJobSseCredentials('p1')).toBeUndefined();
  });
});
