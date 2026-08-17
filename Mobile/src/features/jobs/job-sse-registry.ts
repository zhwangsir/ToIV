/**
 * 会话内作业 SSE 凭据登记（M29.1）
 * - GenerateResponse（src/types/api.ts L123）含 prompt_id+client_id+worker，
 *   JobItem（L29-44）不含 → SSE 仅对本次会话刚提交的作业可用，其余作业仍走既有轮询
 * - 提交成功写入（prompt_id → {clientId, worker}），终态（done/error）清除；
 *   模块级 Map 纯内存态，无 IO 无网络，登出/会话切换经 reset 清空
 */
import type { GenerateResponse } from '@/types/api';

/** SSE 连接凭据（GET /api/jobs/{prompt_id}/events?client_id=&worker= 的两个 query 参数） */
export interface JobSseCreds {
  clientId: string;
  worker: string;
}

const registry = new Map<string, JobSseCreds>();

/** 提交成功登记（重复登记同 prompt_id 覆盖，对齐重提交语义） */
export function registerJobSseCreds(res: GenerateResponse): void {
  registry.set(res.prompt_id, { clientId: res.client_id, worker: res.worker });
}

/** 查询登记；未登记（非本次会话提交/已终态清除）返回 null */
export function getJobSseCreds(promptId: string): JobSseCreds | null {
  return registry.get(promptId) ?? null;
}

/** 终态清除（幂等空操作） */
export function clearJobSseCreds(promptId: string): void {
  registry.delete(promptId);
}

/** 会话级清空（登出/测试隔离） */
export function resetJobSseRegistry(): void {
  registry.clear();
}
