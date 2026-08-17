import { beforeEach, describe, expect, it } from 'vitest';

import {
  agentTaskAction,
  cancelAgentRun,
  getAgentRun,
  getAgentRunResult,
  listAgentRuns,
  resumeAgentRun,
  updateAgentRunPlan,
  uploadAgentTaskAsset,
  watchAgentRunEvents,
} from '@/api';
import { setApiBaseOverride } from '@/api/config';
import { setToken } from '@/api/client';
import type { AgentRunDetail, AgentRunSseEvent, AgentRunTask } from '@/types/api';
import {
  enqueueChunkedResponse,
  enqueueResponse,
  installMockUni,
  lastRequest,
  lastUpload,
  setChunkedError,
  setUploadResult,
} from './helpers/mock-uni';

beforeEach(() => {
  installMockUni();
  setToken(null);
  setApiBaseOverride(null);
});

describe('listAgentRuns', () => {
  it('GET /api/agent-runs 无过滤', async () => {
    enqueueResponse(200, [{ id: 'r1', goal: 'g', status: 'running', level: 'L2', created_at: 'x', task_counts: { total: 1, done: 0, error: 0 } }]);
    const list = await listAgentRuns();
    expect(list).toHaveLength(1);
    expect(lastRequest().url).toContain('/api/agent-runs');
    expect(lastRequest().url).not.toContain('?status=');
  });
  it('status 过滤序列化', async () => {
    enqueueResponse(200, []);
    await listAgentRuns('awaiting_confirm');
    expect(lastRequest().url).toContain('?status=awaiting_confirm');
  });
});

describe('getAgentRun', () => {
  it('GET /api/agent-runs/{id} 路径编码', async () => {
    const detail: AgentRunDetail = {
      id: 'r/1',
      goal: 'g',
      level: 'L1',
      status: 'done',
      error: '',
      plan: [],
      created_at: 'x',
      updated_at: 'y',
    };
    enqueueResponse(200, detail);
    const got = await getAgentRun('r/1');
    expect(got.id).toBe('r/1');
    expect(lastRequest().url).toContain('/api/agent-runs/r%2F1');
  });
});

describe('cancelAgentRun', () => {
  it('POST /api/agent-runs/{id}/cancel', async () => {
    enqueueResponse(200, { run_id: 'r1', status: 'canceled' });
    const res = await cancelAgentRun('r1');
    expect(res.status).toBe('canceled');
    expect(lastRequest().method).toBe('POST');
    expect(lastRequest().url).toContain('/api/agent-runs/r1/cancel');
  });
  it('409 人话透传', async () => {
    enqueueResponse(409, { detail: '当前状态(done)不可取消' });
    await expect(cancelAgentRun('r1')).rejects.toMatchObject({
      status: 409,
      message: '当前状态(done)不可取消',
    });
  });
});

describe('watchAgentRunEvents', () => {
  it('请求构造：GET、SSE 头、after 游标、token 同源注入', async () => {
    setToken('t1');
    enqueueChunkedResponse({ statusCode: 200, chunks: [] });
    const { promise } = watchAgentRunEvents('r1', 0, () => undefined);
    await promise;
    const req = lastRequest();
    expect(req.method).toBe('GET');
    expect(req.url).toContain('/api/agent-runs/r1/events?after=0');
    expect(req.header.Accept).toBe('text/event-stream');
    expect(req.header.Authorization).toBe('Bearer t1');
  });
  it('after 游标透传', async () => {
    enqueueChunkedResponse({ statusCode: 200, chunks: [] });
    const { promise } = watchAgentRunEvents('r1', 42, () => undefined);
    await promise;
    expect(lastRequest().url).toContain('?after=42');
  });
  it('业务事件逐帧上抛（含 done）', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: task_status\ndata: {"task_id":"t1","status":"running","title":"镜头 1"}\n\n',
        'event: done\ndata: {"run_id":"r1","final_url":"/v.mp4"}\n\n',
      ],
    });
    const events: AgentRunSseEvent[] = [];
    const { promise } = watchAgentRunEvents('r1', 0, (e) => events.push(e));
    await promise;
    expect(events).toEqual([
      { type: 'task_status', data: { task_id: 't1', status: 'running', title: '镜头 1' } },
      { type: 'done', data: { run_id: 'r1', final_url: '/v.mp4' } },
    ]);
  });
  it('畸形 JSON 帧跳过，流不中断', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: task_status\ndata: {坏掉的\n\n',
        'event: done\ndata: {"run_id":"r1"}\n\n',
      ],
    });
    const events: AgentRunSseEvent[] = [];
    const { promise } = watchAgentRunEvents('r1', 0, (e) => events.push(e));
    await promise;
    expect(events).toEqual([{ type: 'done', data: { run_id: 'r1' } }]);
  });
  it('非对象载荷跳过', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: [
        'event: task_status\ndata: "just a string"\n\n',
        'event: done\ndata: {"run_id":"r1"}\n\n',
      ],
    });
    const events: AgentRunSseEvent[] = [];
    const { promise } = watchAgentRunEvents('r1', 0, (e) => events.push(e));
    await promise;
    expect(events).toEqual([{ type: 'done', data: { run_id: 'r1' } }]);
  });
  it('非 2xx 按人话体系 reject', async () => {
    enqueueChunkedResponse({ statusCode: 404, chunks: [] });
    const { promise } = watchAgentRunEvents('r1', 0, () => undefined);
    await expect(promise).rejects.toMatchObject({ status: 404, message: '资源不存在或已被清理' });
  });
  it('abort 以「已停止监听」reject', async () => {
    enqueueChunkedResponse({
      statusCode: 200,
      chunks: ['event: done\ndata: {"run_id":"r1"}\n\n'],
    });
    const handle = watchAgentRunEvents('r1', 0, () => {
      handle.abort();
    });
    await expect(handle.promise).rejects.toMatchObject({ message: '已停止监听' });
  });
  it('网络失败 reject', async () => {
    setChunkedError('request:fail ssl hand shake error');
    const { promise } = watchAgentRunEvents('r1', 0, () => undefined);
    await expect(promise).rejects.toMatchObject({ message: '网络连接失败，请检查网络' });
  });
  it('超时 reject', async () => {
    setChunkedError('request:fail timeout');
    const { promise } = watchAgentRunEvents('r1', 0, () => undefined);
    await expect(promise).rejects.toMatchObject({ message: '请求超时，请检查网络后重试' });
  });
});

// ── MP22 二期：确认门裁决 + 卡片干预 ──

describe('resumeAgentRun', () => {
  it('POST /resume：gate/action/feedback 契约字段', async () => {
    enqueueResponse(200, { run_id: 'r1', status: 'planning' });
    const res = await resumeAgentRun('r1', {
      gate: 'plan',
      action: 'reject',
      feedback: '角色发色不一致',
    });
    expect(res).toEqual({ run_id: 'r1', status: 'planning' });
    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/api/agent-runs/r1/resume');
    expect(req.data).toEqual({ gate: 'plan', action: 'reject', feedback: '角色发色不一致' });
  });
  it('feedback 缺省时 body 不含该字段；runId 路径编码', async () => {
    enqueueResponse(200, { run_id: 'r/1', status: 'running' });
    await resumeAgentRun('r/1', { gate: 'assembly', action: 'approve' });
    const req = lastRequest();
    expect(req.url).toContain('/api/agent-runs/r%2F1/resume');
    expect(req.data).toEqual({ gate: 'assembly', action: 'approve' });
  });
  it('409 状态不符人话透传', async () => {
    enqueueResponse(409, { detail: '当前状态(running)不可操作合成确认门' });
    await expect(resumeAgentRun('r1', { gate: 'assembly', action: 'approve' })).rejects.toMatchObject(
      {
        status: 409,
        message: '当前状态(running)不可操作合成确认门',
      },
    );
  });
});

describe('agentTaskAction', () => {
  const taskDetail: AgentRunTask = {
    id: 't/1',
    kind: 'video',
    title: '镜头 1',
    depends_on: [],
    status: 'pending',
    attempt: 1,
    input: { prompt: '雨夜, 雨更大一些' },
    output: {},
    verdict: {},
    gpu_hint: '',
  };
  it('POST /tasks/{tid}/action：runId/taskId 双段路径编码 + body 透传', async () => {
    enqueueResponse(200, taskDetail);
    await agentTaskAction('r/1', 't/1', {
      action: 'regenerate',
      payload: { guidance: '雨更大一些' },
    });
    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/api/agent-runs/r%2F1/tasks/t%2F1/action');
    expect(req.data).toEqual({ action: 'regenerate', payload: { guidance: '雨更大一些' } });
  });
  it('edit：payload={input:{...}} 原样透传，返回卡片详情顶层字段（无包装）', async () => {
    enqueueResponse(200, taskDetail);
    const got = await agentTaskAction('r1', 't1', {
      action: 'edit',
      payload: { input: { prompt: '改写后' } },
    });
    expect(got.id).toBe('t/1');
    expect(got.status).toBe('pending');
    expect(got.attempt).toBe(1);
    expect(lastRequest().data).toEqual({ action: 'edit', payload: { input: { prompt: '改写后' } } });
  });
  it('approve：无 payload 字段', async () => {
    enqueueResponse(200, { ...taskDetail, status: 'approved' });
    const got = await agentTaskAction('r1', 't1', { action: 'approve' });
    expect(got.status).toBe('approved');
    expect(lastRequest().data).toEqual({ action: 'approve' });
  });
  it('409 非 done/error 重生成人话透传', async () => {
    enqueueResponse(409, { detail: '仅已完成/失败的任务可重生成' });
    await expect(agentTaskAction('r1', 't1', { action: 'regenerate' })).rejects.toMatchObject({
      status: 409,
      message: '仅已完成/失败的任务可重生成',
    });
  });
  it('400 合成卡走合成门人话透传', async () => {
    enqueueResponse(400, { detail: '合成任务请走合成确认门' });
    await expect(agentTaskAction('r1', 't1', { action: 'regenerate' })).rejects.toMatchObject({
      status: 400,
      message: '合成任务请走合成确认门',
    });
  });
  it('reprompt：无 payload 字段，返回卡片 input 已写回反推 prompt', async () => {
    enqueueResponse(200, {
      ...taskDetail,
      status: 'done',
      input: { prompt: 'reversed cinematic prompt', negative: 'blurry' },
    });
    const got = await agentTaskAction('r1', 't1', { action: 'reprompt' });
    expect(got.status).toBe('done');
    expect(got.input.prompt).toBe('reversed cinematic prompt');
    expect(lastRequest().data).toEqual({ action: 'reprompt' });
  });
});

// ── MP33 四期：卡片产物直传替换（POST .../tasks/{tid}/upload multipart，字段名 file）──

describe('uploadAgentTaskAsset', () => {
  it('multipart 上传：双段路径编码 + 字段名 file + 返回卡片顶层字段（无包装）', async () => {
    setToken('tk');
    setUploadResult(200, {
      id: 't/1',
      kind: 'video',
      status: 'done',
      output: { url: '/api/studio/files/u1.png', source: 'upload' },
    });
    const got = await uploadAgentTaskAsset('r/1', 't/1', '/tmp/replacement.png');
    expect(got.status).toBe('done');
    expect(got.output).toMatchObject({ source: 'upload' });
    const call = lastUpload();
    expect(call.url).toContain('/api/agent-runs/r%2F1/tasks/t%2F1/upload');
    expect(call.name).toBe('file');
    expect(call.filePath).toBe('/tmp/replacement.png');
    expect(call.header.Authorization).toBe('Bearer tk');
  });

  it('415 魔数不符人话透传', async () => {
    setUploadResult(415, { detail: '文件内容与扩展名不符' });
    await expect(uploadAgentTaskAsset('r1', 't1', '/tmp/fake.png')).rejects.toMatchObject({
      status: 415,
      message: '文件内容与扩展名不符',
    });
  });
});

// ── MP23 三期：计划编辑 POST /plan + 成片结果 GET /result ──

describe('updateAgentRunPlan', () => {
  it('POST /plan：URL/方法/body {tasks: ops} 契约', async () => {
    const planResult = {
      run_id: 'r1',
      plan: {
        tasks: [
          { id: 't1', kind: 'script', title: '改写后', depends_on: [], status: 'pending' },
          { id: 'new-1', kind: 'video', title: '新任务', depends_on: [], status: 'pending' },
        ],
      },
    };
    enqueueResponse(200, planResult);
    const ops = [
      { id: 't1', action: 'update' as const, title: '改写后', input: { prompt: '新文案' } },
      { id: 't2', action: 'remove' as const },
      { id: 'new-1', action: 'add' as const, title: '新任务', input: { prompt: '追加镜头' } },
    ];
    const res = await updateAgentRunPlan('r1', ops);
    expect(res).toEqual(planResult);
    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/api/agent-runs/r1/plan');
    expect(req.data).toEqual({ tasks: ops });
  });
  it('runId 路径编码', async () => {
    enqueueResponse(200, { run_id: 'r/1', plan: { tasks: [] } });
    await updateAgentRunPlan('r/1', [{ id: 't1', action: 'remove' }]);
    expect(lastRequest().url).toContain('/api/agent-runs/r%2F1/plan');
  });
  it('409 非待确认状态人话透传', async () => {
    enqueueResponse(409, { detail: '仅待确认状态可编辑计划' });
    await expect(
      updateAgentRunPlan('r1', [{ id: 't1', action: 'update', title: 'x' }]),
    ).rejects.toMatchObject({ status: 409, message: '仅待确认状态可编辑计划' });
  });
  it('404 任务不存在走 404 硬映射人话（friendlyMessage 既有体系）', async () => {
    enqueueResponse(404, { detail: '任务不存在:t9' });
    await expect(
      updateAgentRunPlan('r1', [{ id: 't9', action: 'remove' }]),
    ).rejects.toMatchObject({ status: 404, message: '资源不存在或已被清理' });
  });
});

describe('getAgentRunResult', () => {
  const resultShape = {
    final_url: '/outputs/lib-4.mp4',
    duration_sec: 7,
    tasks: [
      { id: 't1', title: '镜头 1', kind: 'video', status: 'done', output: { video_url: '/outputs/a.mp4' } },
      { id: 't2', title: '合成成片', kind: 'assemble', status: 'done', output: { url: '/outputs/lib-4.mp4' } },
    ],
  };
  it('GET /result：URL + 返回形状原样透传', async () => {
    enqueueResponse(200, resultShape);
    const res = await getAgentRunResult('r1');
    expect(res).toEqual(resultShape);
    const req = lastRequest();
    expect(req.method).toBe('GET');
    expect(req.url).toContain('/api/agent-runs/r1/result');
  });
  it('runId 路径编码', async () => {
    enqueueResponse(200, resultShape);
    await getAgentRunResult('r/1');
    expect(lastRequest().url).toContain('/api/agent-runs/r%2F1/result');
  });
  it('409 任务尚未完成人话透传', async () => {
    enqueueResponse(409, { detail: '任务尚未完成' });
    await expect(getAgentRunResult('r1')).rejects.toMatchObject({
      status: 409,
      message: '任务尚未完成',
    });
  });
});
