import {
  clearJobSseCreds,
  getJobSseCreds,
  registerJobSseCreds,
  resetJobSseRegistry,
} from '../job-sse-registry';
import type { GenerateResponse } from '@/types/api';

/**
 * 会话内作业 SSE 凭据登记（M29.1）
 * 契约来源：GenerateResponse（src/types/api.ts L123）含 prompt_id+client_id+worker，
 * JobItem（L29-44）不含 → SSE 仅对本次会话刚提交的作业可用；提交写入、终态清除
 */

function makeResponse(overrides: Partial<GenerateResponse> = {}): GenerateResponse {
  return { prompt_id: 'p1', client_id: 'c1', worker: 'http://w1:8188', seed: 7, ...overrides };
}

describe('job-sse-registry（会话内作业 SSE 凭据，M29.1）', () => {
  beforeEach(() => {
    resetJobSseRegistry();
  });

  it('登记后可按 prompt_id 取回 client_id/worker', () => {
    registerJobSseCreds(makeResponse());
    expect(getJobSseCreds('p1')).toEqual({ clientId: 'c1', worker: 'http://w1:8188' });
  });

  it('未登记的 prompt_id 返回 null', () => {
    expect(getJobSseCreds('ghost')).toBeNull();
  });

  it('同 prompt_id 重复登记覆盖（重提交语义）', () => {
    registerJobSseCreds(makeResponse());
    registerJobSseCreds(makeResponse({ client_id: 'c2', worker: 'http://w2:8188' }));
    expect(getJobSseCreds('p1')).toEqual({ clientId: 'c2', worker: 'http://w2:8188' });
  });

  it('多作业并存互不影响', () => {
    registerJobSseCreds(makeResponse());
    registerJobSseCreds(makeResponse({ prompt_id: 'p2', client_id: 'c9' }));
    expect(getJobSseCreds('p1')?.clientId).toBe('c1');
    expect(getJobSseCreds('p2')?.clientId).toBe('c9');
  });

  it('终态清除后取回 null，其余登记保留', () => {
    registerJobSseCreds(makeResponse());
    registerJobSseCreds(makeResponse({ prompt_id: 'p2' }));
    clearJobSseCreds('p1');
    expect(getJobSseCreds('p1')).toBeNull();
    expect(getJobSseCreds('p2')).not.toBeNull();
  });

  it('清除未登记项为空操作不抛错', () => {
    expect(() => clearJobSseCreds('ghost')).not.toThrow();
  });

  it('reset 清空全部登记（会话切换/登出语义）', () => {
    registerJobSseCreds(makeResponse());
    registerJobSseCreds(makeResponse({ prompt_id: 'p2' }));
    resetJobSseRegistry();
    expect(getJobSseCreds('p1')).toBeNull();
    expect(getJobSseCreds('p2')).toBeNull();
  });
});
