/**
 * 会话内作业 SSE 凭据登记（MP29）
 * - GenerateResponse 含 prompt_id+client_id+worker，但 JobItem 不持久化 client_id/worker
 *   → SSE 只对「本次会话内刚提交」的作业可用；重启/离开后的作业仍走既有轮询
 * - 纯内存 Map（不落地 storage），模块级单例；容量上限防无限膨胀（LRU：重登记刷新位次）
 * - 纯函数无运行时依赖，node 环境可直接单测
 */
import type { GenerateResponse } from '@/types/api';

export interface JobSseCredentials {
  clientId: string;
  worker: string;
}

/** 容量上限：单会话正常提交个位数，32 足以覆盖连打场景且防内存膨胀 */
export const JOB_SSE_REGISTRY_CAPACITY = 32;

/** Map 迭代序 = 插入序，重登记先删后插即刷新为最新（淘汰时摘首个 = 最旧） */
const registry = new Map<string, JobSseCredentials>();

/** 提交成功时登记（index.vue handleSubmit 全链路分支统一汇入） */
export function registerJobSseCredentials(res: GenerateResponse): void {
  registry.delete(res.prompt_id);
  registry.set(res.prompt_id, { clientId: res.client_id, worker: res.worker });
  while (registry.size > JOB_SSE_REGISTRY_CAPACITY) {
    const oldest = registry.keys().next();
    if (oldest.done) break;
    registry.delete(oldest.value);
  }
}

export function getJobSseCredentials(promptId: string): JobSseCredentials | undefined {
  return registry.get(promptId);
}

/** 终态/回退轮询时清除（后续列表刷新不再尝试起 SSE 流） */
export function unregisterJobSseCredentials(promptId: string): void {
  registry.delete(promptId);
}

export function clearJobSseRegistry(): void {
  registry.clear();
}

export function jobSseRegistrySize(): number {
  return registry.size;
}
