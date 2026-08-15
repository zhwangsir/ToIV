/**
 * useStudioProject 单测用的 @/lib/api 可控替身(经 tests/loader.mjs 静态映射)。
 * - impl:各方法的可替换实现,用例按需覆盖;
 * - calls:调用计数,用于断言「失败时不静默 refresh」之类行为;
 * - 类型从真实 lib/api 引入(仅类型,运行时擦除),保证与生产签名一致。
 */
import type { StudioProjectDetail, StudioShot, StudioShotInput } from "../../lib/api";

export const calls = {
  getStudioProject: 0,
  saveStudioShots: 0,
  renderStudioShot: 0,
  renderStudioAll: 0,
  voiceStudioShot: 0,
  lipsyncStudioShot: 0,
  assembleStudio: 0,
};

export function makeShot(id: string): StudioShot {
  return {
    id,
    project_id: "p1",
    idx: 0,
    scene: "",
    prompt: "",
    negative: "",
    camera: "",
    dialogue: "",
    speaker: "",
    duration_sec: 4,
    characters: [],
    render_mode: "video",
    status: "draft",
    image_url: "",
    video_url: "",
    voice_url: "",
    final_clip_url: "",
    error: "",
  };
}

export function makeDetail(pid: string): StudioProjectDetail {
  return {
    id: pid,
    title: "测试项目",
    premise: "",
    style: "",
    ckpt_name: "",
    render_mode_default: "video",
    width: 768,
    height: 384,
    fps: 16,
    status: "draft",
    final_url: "",
    created_at: "",
    updated_at: "",
    characters: [],
    shots: [],
  };
}

const defaultImpl = {
  getStudioProject: async (pid: string): Promise<StudioProjectDetail> => makeDetail(pid),
  saveStudioShots: async (
    _pid: string,
    _shots: StudioShotInput[],
  ): Promise<{ shots: StudioShot[] }> => ({ shots: [] }),
  renderStudioShot: async (sid: string): Promise<StudioShot> => makeShot(sid),
  renderStudioAll: async (_pid: string): Promise<{ rendered: number; failed: number }> => ({
    rendered: 0,
    failed: 0,
  }),
  voiceStudioShot: async (sid: string): Promise<StudioShot> => makeShot(sid),
  lipsyncStudioShot: async (sid: string): Promise<StudioShot> => makeShot(sid),
  assembleStudio: async (pid: string): Promise<StudioProjectDetail> => makeDetail(pid),
};

export const impl = { ...defaultImpl };

/** 恢复默认实现并清零调用计数(每个用例前调用)。 */
export function resetImpl(): void {
  Object.assign(impl, defaultImpl);
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
}

export const getStudioProject = (pid: string): Promise<StudioProjectDetail> => {
  calls.getStudioProject++;
  return impl.getStudioProject(pid);
};
export const saveStudioShots = (
  pid: string,
  shots: StudioShotInput[],
): Promise<{ shots: StudioShot[] }> => {
  calls.saveStudioShots++;
  return impl.saveStudioShots(pid, shots);
};
export const renderStudioShot = (sid: string): Promise<StudioShot> => {
  calls.renderStudioShot++;
  return impl.renderStudioShot(sid);
};
export const renderStudioAll = (pid: string): Promise<{ rendered: number; failed: number }> => {
  calls.renderStudioAll++;
  return impl.renderStudioAll(pid);
};
export const voiceStudioShot = (sid: string): Promise<StudioShot> => {
  calls.voiceStudioShot++;
  return impl.voiceStudioShot(sid);
};
export const lipsyncStudioShot = (sid: string): Promise<StudioShot> => {
  calls.lipsyncStudioShot++;
  return impl.lipsyncStudioShot(sid);
};
export const assembleStudio = (pid: string): Promise<StudioProjectDetail> => {
  calls.assembleStudio++;
  return impl.assembleStudio(pid);
};

// ===========================================================================
// Agent Team(R3.1)替身扩展:useAgentRun / useAgentRunList 单测经 loader 映射到这里
// ===========================================================================
import type {
  AgentPlanEditOp,
  AgentResumeBody,
  AgentRunCreateResult,
  AgentRunDetail,
  AgentRunResult,
  AgentRunSummary,
  AgentRunTask,
  AgentTaskActionBody,
} from "../../lib/api";

export const agentCalls = {
  createAgentRun: 0,
  listAgentRuns: 0,
  getAgentRun: 0,
  updateAgentRunPlan: 0,
  resumeAgentRun: 0,
  agentTaskAction: 0,
  cancelAgentRun: 0,
  getAgentRunResult: 0,
};

/** 构造详情任务卡片(可字段覆盖)。 */
export function makeAgentTask(id: string, over: Partial<AgentRunTask> = {}): AgentRunTask {
  return {
    id,
    kind: "video",
    title: `任务 ${id}`,
    depends_on: [],
    status: "pending",
    attempt: 0,
    input: { prompt: "" },
    output: {},
    verdict: "",
    gpu_hint: "",
    ...over,
  };
}

/** 构造 run 详情(默认 running,两任务)。 */
export function makeAgentRunDetail(
  runId: string,
  over: Partial<AgentRunDetail> = {},
): AgentRunDetail {
  return {
    id: runId,
    goal: "拍一支 30 秒短片",
    level: "L2",
    status: "running",
    error: "",
    plan: [makeAgentTask("t1"), makeAgentTask("t2", { depends_on: ["t1"] })],
    created_at: "2026-08-14T00:00:00Z",
    updated_at: "2026-08-14T00:00:00Z",
    ...over,
  };
}

const agentDefaultImpl = {
  createAgentRun: async (_body: {
    goal: string;
    level?: string;
    opts?: Record<string, unknown>;
  }): Promise<AgentRunCreateResult> => ({ level: "L0", ack: "已收到", run_id: null }),
  listAgentRuns: async (_params?: {
    limit?: number;
    status?: string;
  }): Promise<AgentRunSummary[]> => [],
  getAgentRun: async (runId: string): Promise<AgentRunDetail> => makeAgentRunDetail(runId),
  updateAgentRunPlan: async (
    _runId: string,
    _ops: AgentPlanEditOp[],
  ): Promise<{ ok: boolean }> => ({ ok: true }),
  resumeAgentRun: async (
    _runId: string,
    _body: AgentResumeBody,
  ): Promise<{ ok: boolean }> => ({ ok: true }),
  agentTaskAction: async (
    runId: string,
    taskId: string,
    _body: AgentTaskActionBody,
  ): Promise<{ ok: boolean; task: AgentRunTask }> => ({
    ok: true,
    task: makeAgentTask(taskId),
  }),
  cancelAgentRun: async (_runId: string): Promise<{ ok: boolean }> => ({ ok: true }),
  getAgentRunResult: async (runId: string): Promise<AgentRunResult> => ({
    final_url: "",
    duration_sec: 0,
    tasks: makeAgentRunDetail(runId).plan,
  }),
};

export const agentImpl = { ...agentDefaultImpl };

/** 恢复默认实现并清零 agent 调用计数(每个用例前调用)。 */
export function resetAgentImpl(): void {
  Object.assign(agentImpl, agentDefaultImpl);
  for (const k of Object.keys(agentCalls) as (keyof typeof agentCalls)[]) agentCalls[k] = 0;
}

export const createAgentRun = (body: {
  goal: string;
  level?: string;
  opts?: Record<string, unknown>;
}): Promise<AgentRunCreateResult> => {
  agentCalls.createAgentRun++;
  return agentImpl.createAgentRun(body);
};
export const listAgentRuns = (params?: {
  limit?: number;
  status?: string;
}): Promise<AgentRunSummary[]> => {
  agentCalls.listAgentRuns++;
  return agentImpl.listAgentRuns(params);
};
export const getAgentRun = (runId: string): Promise<AgentRunDetail> => {
  agentCalls.getAgentRun++;
  return agentImpl.getAgentRun(runId);
};
export const updateAgentRunPlan = (
  runId: string,
  ops: AgentPlanEditOp[],
): Promise<{ ok: boolean }> => {
  agentCalls.updateAgentRunPlan++;
  return agentImpl.updateAgentRunPlan(runId, ops);
};
export const resumeAgentRun = (
  runId: string,
  body: AgentResumeBody,
): Promise<{ ok: boolean }> => {
  agentCalls.resumeAgentRun++;
  return agentImpl.resumeAgentRun(runId, body);
};
export const agentTaskAction = (
  runId: string,
  taskId: string,
  body: AgentTaskActionBody,
): Promise<{ ok: boolean; task: AgentRunTask }> => {
  agentCalls.agentTaskAction++;
  return agentImpl.agentTaskAction(runId, taskId, body);
};
export const cancelAgentRun = (runId: string): Promise<{ ok: boolean }> => {
  agentCalls.cancelAgentRun++;
  return agentImpl.cancelAgentRun(runId);
};
export const getAgentRunResult = (runId: string): Promise<AgentRunResult> => {
  agentCalls.getAgentRunResult++;
  return agentImpl.getAgentRunResult(runId);
};
/** SSE 地址构造替身:返回可控假地址,由 FakeEventSource 捕获。 */
export const agentRunEventsUrl = (runId: string, after = 0): string =>
  `mock://agent-run-events/${runId}?after=${after}`;

// ===========================================================================
// 智能体会话(H2)替身扩展:useAgentConversations(AssistantView)单测经 loader 映射到这里
// ===========================================================================
import type {
  AgentChatStreamBody,
  AgentEvent,
  AgentSessionDetail,
  AgentSessionSummary,
} from "../../lib/api";

export const sessCalls = {
  listAgentSessions: 0,
  getAgentSession: 0,
  forkAgentSession: 0,
  deleteAgentSession: 0,
  agentChatStream: 0,
  getLlmModel: 0,
};

export function makeSessionSummary(
  id: string,
  over: Partial<AgentSessionSummary> = {},
): AgentSessionSummary {
  return {
    id,
    title: `会话 ${id}`,
    nsfw: false,
    created_at: "2026-08-14T00:00:00Z",
    updated_at: "2026-08-14T00:00:00Z",
    message_count: 0,
    ...over,
  };
}

export function makeSessionDetail(
  id: string,
  over: Partial<AgentSessionDetail> = {},
): AgentSessionDetail {
  return { ...makeSessionSummary(id), messages: [], ...over };
}

const sessDefaultImpl = {
  listAgentSessions: async (_signal?: AbortSignal): Promise<AgentSessionSummary[]> => [],
  getAgentSession: async (id: string, _signal?: AbortSignal): Promise<AgentSessionDetail> =>
    makeSessionDetail(id),
  forkAgentSession: async (id: string, _at?: number): Promise<AgentSessionSummary> =>
    makeSessionSummary(`${id}-fork`),
  deleteAgentSession: async (_id: string): Promise<void> => {},
  agentChatStream: async (
    _body: AgentChatStreamBody,
    _onEvent: (ev: AgentEvent) => void,
    _signal?: AbortSignal,
  ): Promise<{ sessionId: string | null }> => ({ sessionId: "srv-new" }),
  getLlmModel: async (_signal?: AbortSignal): Promise<{ display_model?: string } | null> =>
    null,
};

export const sessImpl = { ...sessDefaultImpl };

/** 恢复默认实现并清零会话调用计数(每个用例前调用)。 */
export function resetSessImpl(): void {
  Object.assign(sessImpl, sessDefaultImpl);
  for (const k of Object.keys(sessCalls) as (keyof typeof sessCalls)[]) sessCalls[k] = 0;
}

export const listAgentSessions = (signal?: AbortSignal): Promise<AgentSessionSummary[]> => {
  sessCalls.listAgentSessions++;
  return sessImpl.listAgentSessions(signal);
};
export const getAgentSession = (
  id: string,
  signal?: AbortSignal,
): Promise<AgentSessionDetail> => {
  sessCalls.getAgentSession++;
  return sessImpl.getAgentSession(id, signal);
};
export const forkAgentSession = (
  id: string,
  at?: number,
): Promise<AgentSessionSummary> => {
  sessCalls.forkAgentSession++;
  return sessImpl.forkAgentSession(id, at);
};
export const deleteAgentSession = (id: string): Promise<void> => {
  sessCalls.deleteAgentSession++;
  return sessImpl.deleteAgentSession(id);
};
export const agentChatStream = (
  body: AgentChatStreamBody,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<{ sessionId: string | null }> => {
  sessCalls.agentChatStream++;
  return sessImpl.agentChatStream(body, onEvent, signal);
};
export const getLlmModel = (
  signal?: AbortSignal,
): Promise<{ display_model?: string } | null> => {
  sessCalls.getLlmModel++;
  return sessImpl.getLlmModel(signal);
};

/** @/lib/docs 经 loader 也会解析到本替身:docs.ts 只需这两个具名导出(链接期)。 */
export const apiFetch = (): Promise<Response> =>
  Promise.reject(new Error("apiFetch 未在会话测试中使用"));
export const authHeaders = (): Record<string, string> => ({});

/** 产物 URL 构造替身:直接透传(测试不断言完整 URL)。 */
export const imageUrl = (path: string): string => path;

// ===========================================================================
// 作品库(libraryViews.test.ts:LibraryView 经 loader 映射到这里)
// ===========================================================================
import type { JobItem } from "../../lib/types";

/** 作品列表替身:默认空库,用例按需覆盖 impl。 */
export const libImpl = {
  listJobs: async (): Promise<JobItem[]> => [],
};
export const listJobs = (): Promise<JobItem[]> => libImpl.listJobs();
export const deleteJob = async (_jobId: string): Promise<void> => {};
export const invalidateJobs = (): void => undefined;
/** R18 请求头开关替身(r18.ts 链接期需要,运行期无副作用)。 */
export const setNsfwIntent = (_on: boolean): void => undefined;

// ===========================================================================
// UI-B 视图组件替身扩展(uiBViews.test.ts:PromptBar → ReverseButton 经 loader 映射到这里)
// ===========================================================================
/** 提示词反推替身:永不真实请求,返回固定空结构。 */
export const reversePrompt = async (): Promise<{ prompt: string; negative: string }> => ({
  prompt: "",
  negative: "",
});
