import {
  agentChatStream,
  agentTaskAction,
  apiFetch,
  assetImageUrl,
  cancelAgentRun,
  createAsset,
  deleteAgentSession,
  deleteAsset,
  deleteDoc,
  deleteJob,
  fetchEngines,
  fetchMe,
  fetchVersions,
  forkAgentSession,
  getAgentRun,
  getAgentRunResult,
  getAgentSession,
  getAsset,
  listAgentRuns,
  listAgentSessions,
  listAssets,
  listDocs,
  listJobs,
  login,
  mediaUrl,
  optimizePrompt,
  rerunJob,
  resumeAgentRun,
  reversePrompt,
  setNsfwIntent,
  setToken,
  submitAceMusic,
  submitAvatarTalk,
  submitH3I2V,
  submitH3T2V,
  submitImg2Img,
  submitLongCatContinue,
  submitLongCatI2V,
  submitLongCatT2V,
  submitLtx25I2V,
  submitLtx25T2V,
  submitLtxNsfwI2V,
  submitLtxNsfwLipsync,
  submitLtxNsfwT2V,
  submitTxt2Img,
  submitWanAnimate,
  submitWanVace,
  updateAgentRunPlan,
  updateAsset,
  uploadAgentTaskAsset,
  uploadAudio,
  uploadDoc,
  uploadImage,
  uploadKindForEngine,
  uploadVideo,
  watchAgentRunEvents,
  ApiError,
} from '../api';
import { fetch as expoFetch } from 'expo/fetch';

// expo-secure-store 在 jest 环境无原生实现，用内存 Map 模拟
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

// API 基址固定，避免依赖 expo-constants 真值
jest.mock('../config', () => ({
  resolveApiBase: () => 'https://api.test',
}));

// expo/fetch 为原生流式实现，jest 环境替换为可控 mock（M19 对话 SSE 专用通道）
jest.mock('expo/fetch', () => ({
  fetch: jest.fn(),
}));

const mockFetch = jest.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken(null);
  });

  it('登录映射 token 字段（不是 access_token）并落 secure store', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        token: 'tk-123',
        user: { id: 'u1', email: 'a@b.c', role: 'user' },
      }),
    );
    const result = await login('a@b.c', 'pw');
    expect(result.token).toBe('tk-123');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/auth/login');
    expect(init.method).toBe('POST');
  });

  it('登录响应缺 token 字段视为协议错误', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'wrong-field', user: {} }),
    );
    await expect(login('a@b.c', 'pw')).rejects.toThrow(/token/);
  });

  it('已登录请求自动带 Authorization Bearer', async () => {
    await setToken('tk-abc');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await apiFetch('/api/jobs');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tk-abc',
    );
  });

  it('NSFW 意图按请求注入 X-NSFW 头', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await apiFetch('/api/nsfw/engines', { nsfw: true });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-NSFW']).toBe('1');
  });

  it('401 抛出友好人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { detail: 'expired' }));
    await expect(apiFetch('/api/me')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('登录'),
    });
  });

  it('网络层异常包装为 ApiError(0)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(ApiError);
  });

  it('fetchMe 命中 /api/auth/me 并返回 { user, usage }', async () => {
    await setToken('tk-me');
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { user: { id: 'u9', email: 'm@n.o', role: 'user' }, usage: { credits: 3 } }),
    );
    const me = await fetchMe();
    expect(me.user.id).toBe('u9');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/auth/me');
  });
});

describe('api client 分支覆盖', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken(null);
    setNsfwIntent(false);
  });

  it.each([
    [403, '没有权限执行此操作'],
    [404, '资源不存在或已被清理'],
    [429, '请求过于频繁，请稍后再试'],
    [500, '服务暂时不可用，请稍后重试'],
  ])('状态码 %i 映射友好人话', async (status, expected) => {
    mockFetch.mockResolvedValueOnce(jsonResponse(status, {}));
    await expect(apiFetch('/x')).rejects.toMatchObject({ status, message: expected });
  });

  it('未知状态码透传服务端 detail', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { detail: '参数不合法' }));
    await expect(apiFetch('/x')).rejects.toMatchObject({ status: 400, message: '参数不合法' });
  });

  it('非 JSON 错误体走兜底人话', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('<html>oops</html>', { status: 418, headers: { 'Content-Type': 'text/html' } }),
    );
    await expect(apiFetch('/x')).rejects.toMatchObject({ status: 418, message: '请求失败，请重试' });
  });

  it('204 无响应体返回 undefined', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiFetch('/x')).resolves.toBeUndefined();
  });

  it('绝对 URL 不拼接 base', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await apiFetch('https://cdn.example.com/file.json');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://cdn.example.com/file.json');
  });

  it('无 token 请求不带 Authorization', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await apiFetch('/x');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('带 body 的 POST 自动补 Content-Type 并序列化', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await apiFetch('/x', { method: 'POST', body: { a: 1 } });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('单次请求 nsfw:false 可压过全局意图', async () => {
    setNsfwIntent(true);
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await apiFetch('/x', { nsfw: false });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-NSFW']).toBeUndefined();
  });

  it('内部超时触发「请求超时」人话', async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );
      const pending = apiFetch('/slow');
      const assertion = expect(pending).rejects.toMatchObject({
        status: 0,
        message: '请求超时，请检查网络后重试',
      });
      await jest.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('外部 signal 预中止视为调用方取消（不算超时）', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch.mockImplementationOnce(() =>
      Promise.reject(new DOMException('Aborted', 'AbortError')),
    );
    await expect(apiFetch('/x', { signal: controller.signal })).rejects.toMatchObject({
      status: 0,
      message: '网络连接失败，请检查网络',
    });
  });
});

describe('mediaUrl：产物路径拼 token', () => {
  beforeEach(async () => {
    await setToken(null);
  });

  it('相对路径拼 base，登录后附 ?token=', async () => {
    await setToken('tk-media');
    expect(mediaUrl('/files/out/a.png')).toBe(
      'https://api.test/files/out/a.png?token=tk-media',
    );
  });

  it('缺前导斜杠的相对路径自动补 /', async () => {
    await setToken('tk-media');
    expect(mediaUrl('files/a.png')).toBe('https://api.test/files/a.png?token=tk-media');
  });

  it('绝对 http URL 不拼 base 但仍附 token', async () => {
    await setToken('tk media'); // 含空格验证 encodeURIComponent
    expect(mediaUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png?token=tk%20media',
    );
  });

  it('已有 query 参数时用 & 续接', async () => {
    await setToken('tk-q');
    expect(mediaUrl('/view?w=100')).toBe('https://api.test/view?w=100&token=tk-q');
  });

  it('未登录时原样返回（交由 401 兜底）', () => {
    expect(mediaUrl('/files/a.png')).toBe('https://api.test/files/a.png');
  });

  it('空路径返回空串', async () => {
    await setToken('tk-media');
    expect(mediaUrl('')).toBe('');
  });
});

describe('生成主流程 API（M4）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m4');
  });

  it('fetchEngines 命中 /api/models/engines 并解出 engines 数组', async () => {
    const engines = [
      { id: 'sdxl', label: 'SDXL', kind: 'image', available: true, nsfw: false, params: [] },
    ];
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { engines, count: 1 }));
    const result = await fetchEngines();
    expect(result).toEqual(engines);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/models/engines');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m4');
  });

  it('fetchEngines 响应缺 engines 字段时回落空数组（不炸 UI）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(fetchEngines()).resolves.toEqual([]);
  });

  it('submitTxt2Img POST /api/generate/txt2img 并序列化请求体', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 42 }),
    );
    const result = await submitTxt2Img({ positive: 'a cat', width: 832, height: 1216 });
    expect(result).toEqual({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 42 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/generate/txt2img');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      positive: 'a cat',
      width: 832,
      height: 1216,
    });
  });

  it('listJobs 默认 limit=50，status 经 encodeURIComponent', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await listJobs({ status: 'a b' });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/jobs?limit=50&status=a%20b');
  });

  it('listJobs 缺省参数只带 limit，空 status 不出现在 qs', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await listJobs({ limit: 10 });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/jobs?limit=10');
  });

  it('listJobs offset>0 时 qs 带 &offset=（M15 无限分页）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await listJobs({ limit: 50, offset: 100 });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/jobs?limit=50&offset=100');
  });

  it('listJobs offset=0 与缺省一样不出现在 qs', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await listJobs({ limit: 50, offset: 0 });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/jobs?limit=50');
  });

  it('listJobs offset 与 status 同时出现按 limit/offset/status 序拼接', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await listJobs({ limit: 50, offset: 50, status: 'done' });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/jobs?limit=50&offset=50&status=done');
  });

  it('listJobs 原样返回作业数组（最新在前由后端保证）', async () => {
    const jobs = [
      {
        id: 'j1',
        prompt_id: 'p1',
        kind: 'txt2img',
        status: 'done',
        prompt: 'cat',
        seed: 1,
        created_at: '2026-08-12T10:00:00',
        results: ['/files/a.png'],
        nsfw: false,
        parent_id: '',
        root_id: 'j1',
        has_params: true,
      },
    ];
    mockFetch.mockResolvedValueOnce(jsonResponse(200, jobs));
    await expect(listJobs()).resolves.toEqual(jobs);
  });

  it('deleteJob 命中 DELETE /api/jobs/{id}，id 经 encodeURIComponent', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteJob('job/1');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/jobs/job%2F1');
    expect(init.method).toBe('DELETE');
  });

  it('deleteJob 404 时抛「资源不存在」人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { detail: '作品不存在' }));
    await expect(deleteJob('ghost')).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});

describe('版本链 API（M7）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m7');
  });

  it('rerunJob POST /api/jobs/{key}/rerun，key 经 encodeURIComponent，默认空体走 keep 语义', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        prompt_id: 'p2',
        client_id: 'c1',
        worker: 'w1',
        seed: 7,
        job_id: 'j2',
        parent_id: 'j1',
        root_id: 'j1',
      }),
    );
    const result = await rerunJob('job/1');
    expect(result.job_id).toBe('j2');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/jobs/job%2F1/rerun');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m7');
  });

  it('rerunJob 序列化 seed_mode/seed/overrides 请求体', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p2', client_id: 'c1', worker: 'w1', seed: 9 }),
    );
    await rerunJob('j1', { seed_mode: 'explicit', seed: 9, overrides: { positive: 'dog' } });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      seed_mode: 'explicit',
      seed: 9,
      overrides: { positive: 'dog' },
    });
  });

  it('rerunJob 400（旧作品无快照/类型不支持）透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(400, { detail: '该作品是旧版数据,缺少参数快照,无法精确重生' }),
    );
    await expect(rerunJob('legacy')).rejects.toMatchObject({
      status: 400,
      message: '该作品是旧版数据,缺少参数快照,无法精确重生',
    });
  });

  it('fetchVersions GET /api/jobs/{key}/versions，原样返回版本数组（时间升序）', async () => {
    const versions = [
      { id: 'j1', created_at: '2026-08-12T10:00:00' },
      { id: 'j2', created_at: '2026-08-12T11:00:00' },
    ];
    mockFetch.mockResolvedValueOnce(jsonResponse(200, versions));
    const result = await fetchVersions('j1');
    expect(result).toEqual(versions);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/jobs/j1/versions');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('fetchVersions 404 时抛「资源不存在」人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { detail: '作品不存在' }));
    await expect(fetchVersions('ghost')).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});

describe('图生图链路 API（M8）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m8');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uploadImage POST /api/upload?kind=img2img：FormData 直传且不手设 Content-Type', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'a.png', worker: 'http://w1' }));
    const result = await uploadImage({
      uri: 'file:///tmp/ref.png',
      fileName: 'ref.png',
      mimeType: 'image/png',
    });
    expect(result).toEqual({ filename: 'a.png', worker: 'http://w1' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/upload?kind=img2img');
    expect(init.method).toBe('POST');
    // multipart 边界由运行时生成，禁止手设 Content-Type（否则后端解不出字段）
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m8');
    expect(init.body).toBeInstanceOf(FormData);
    // RN 文件三段式 { uri, name, type } 已挂到 image 字段
    expect(appendSpy).toHaveBeenCalledWith('image', {
      uri: 'file:///tmp/ref.png',
      name: 'ref.png',
      type: 'image/png',
    });
  });

  it('uploadImage fileName 缺失时按 mimeType 推扩展名兜底', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'a.webp', worker: 'w1' }));
    await uploadImage({ uri: 'file:///tmp/x', fileName: null, mimeType: 'image/webp' });
    expect(appendSpy).toHaveBeenCalledWith('image', {
      uri: 'file:///tmp/x',
      name: 'upload.webp',
      type: 'image/webp',
    });
  });

  it('uploadImage 自定义 kind 经 encodeURIComponent', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'a.png', worker: 'w1' }));
    await uploadImage({ uri: 'file:///tmp/a.png', fileName: 'a.png' }, 'ltx i2v');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/upload?kind=ltx%20i2v');
  });

  it('uploadImage 415（三重白名单拦截）透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(415, { detail: '文件内容与扩展名不符' }));
    await expect(
      uploadImage({ uri: 'file:///tmp/fake.png', fileName: 'fake.png' }),
    ).rejects.toMatchObject({ status: 415, message: '文件内容与扩展名不符' });
  });

  it('submitImg2Img POST /api/generate/img2img 并序列化请求体（含 image/worker/denoise）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 42 }),
    );
    const result = await submitImg2Img({
      positive: 'a cat',
      image: 'ref.png',
      worker: 'http://w1',
      denoise: 0.45,
      steps: 28,
    });
    expect(result).toEqual({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 42 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/generate/img2img');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      positive: 'a cat',
      image: 'ref.png',
      worker: 'http://w1',
      denoise: 0.45,
      steps: 28,
    });
  });

  it('submitImg2Img 503（指定 worker 缺模型）走 5xx 兜底人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(503, { detail: '指定 worker 缺少该任务所需模型' }));
    await expect(
      submitImg2Img({ positive: 'a', image: 'r.png', worker: 'http://w1' }),
    ).rejects.toMatchObject({ status: 503, message: '服务暂时不可用，请稍后重试' });
  });
});

describe('SFW 视频引擎链路 API（M9）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m9');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('submitLtx25T2V POST /api/ltx25/t2v 并序列化请求体', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 1 }),
    );
    const body = {
      positive: '一只猫在跑步',
      negative: '低画质',
      width: 960,
      height: 544,
      length: 121,
      fps: 24,
      steps: 8,
      seed: 42,
    };
    const result = await submitLtx25T2V(body);
    expect(result).toEqual({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 1 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/ltx25/t2v');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m9');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitLtx25T2V 走长超时档（30s 不中止，180s 超时人话）', async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );
      const pending = submitLtx25T2V({ positive: '一只猫在跑步' });
      let rejected = false;
      void pending.catch(() => {
        rejected = true;
      });
      const assertion = expect(pending).rejects.toMatchObject({
        status: 0,
        message: '请求超时，请检查网络后重试',
      });
      // 常规档 30s 对长任务太短：不应中止
      await jest.advanceTimersByTimeAsync(30_000);
      expect(rejected).toBe(false);
      // 长档 180s 到点中止
      await jest.advanceTimersByTimeAsync(150_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('视频提交 422（FastAPI detail 数组）展开首条 msg（对齐 Web _postLtx25/_postWan）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        detail: [{ loc: ['body', 'length'], msg: '长度须满足 8k+1 帧网格', type: 'value_error' }],
      }),
    );
    await expect(submitLtx25T2V({ positive: 'a', length: 100 })).rejects.toMatchObject({
      status: 422,
      message: '长度须满足 8k+1 帧网格',
    });
  });

  it('视频提交错误 detail 为字符串时透传', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { detail: 'worker 不在线' }));
    await expect(
      submitWanVace({ positive: 'a', images: ['a.png'], worker: 'http://w1' }),
    ).rejects.toMatchObject({ status: 400, message: 'worker 不在线' });
  });

  it('submitLtx25I2V POST /api/ltx25/i2v 并序列化请求体（含 image/worker/strength）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p2', client_id: 'c1', worker: 'w1', seed: 7 }),
    );
    const body = {
      positive: '让照片动起来',
      image: 'ref.png',
      worker: 'http://w1',
      strength: 0.7,
      width: 960,
      height: 544,
      length: 121,
      fps: 24,
      steps: 8,
    };
    await submitLtx25I2V(body);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/ltx25/i2v');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitWanAnimate POST /api/wan/animate 并序列化请求体（含 image/video/worker）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p3', client_id: 'c1', worker: 'w1', seed: 9 }),
    );
    const body = {
      positive: '角色跳舞',
      image: 'role.png',
      video: 'drive.mp4',
      worker: 'http://w1',
      width: 832,
      height: 480,
      num_frames: 121,
      steps: 6,
      fps: 16,
    };
    await submitWanAnimate(body);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/wan/animate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitWanVace POST /api/wan/vace 并序列化请求体（images 数组 + 第一张落点 worker）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p4', client_id: 'c1', worker: 'w1', seed: 3 }),
    );
    const body = {
      positive: '多图一致性视频',
      images: ['a.png', 'b.png'],
      worker: 'http://w1',
      num_frames: 81,
      steps: 20,
      fps: 16,
    };
    await submitWanVace(body);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/wan/vace');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('uploadVideo POST /api/upload?kind=wan_animate&worker=<钉点>：字段名固定 image、三段式直传、不手设 Content-Type', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'drive.mp4', worker: 'http://w1' }));
    const result = await uploadVideo(
      { uri: 'file:///tmp/drive.mp4', fileName: 'drive.mp4', mimeType: 'video/mp4' },
      'wan_animate',
      'http://w1',
    );
    expect(result).toEqual({ filename: 'drive.mp4', worker: 'http://w1' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/upload?kind=wan_animate&worker=http%3A%2F%2Fw1');
    expect(init.method).toBe('POST');
    // multipart 边界由运行时生成，禁止手设 Content-Type
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m9');
    expect(init.body).toBeInstanceOf(FormData);
    // 视频同样挂在 image 字段（upload.py UploadFile 形参名）
    expect(appendSpy).toHaveBeenCalledWith('image', {
      uri: 'file:///tmp/drive.mp4',
      name: 'drive.mp4',
      type: 'video/mp4',
    });
  });

  it('uploadVideo 无钉点时 qs 仅 kind；fileName 缺失按 mimeType 推扩展名（quicktime→mov）', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'v.mov', worker: 'w1' }));
    await uploadVideo(
      { uri: 'file:///tmp/v', fileName: null, mimeType: 'video/quicktime' },
      'wan_animate',
    );
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/upload?kind=wan_animate');
    expect(appendSpy).toHaveBeenCalledWith('image', {
      uri: 'file:///tmp/v',
      name: 'upload.mov',
      type: 'video/quicktime',
    });
  });

  it('uploadVideo 413（>200MB）透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(413, { detail: '文件超过大小限制(200MB)' }));
    await expect(
      uploadVideo({ uri: 'file:///tmp/big.mp4', fileName: 'big.mp4' }, 'wan_animate'),
    ).rejects.toMatchObject({ status: 413, message: '文件超过大小限制(200MB)' });
  });

  it('uploadImage 第三参 pinWorker 钉到指定 worker（wan-vace 第 2-4 张钉第一张落点）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'b.png', worker: 'http://w1' }));
    await uploadImage({ uri: 'file:///tmp/b.png', fileName: 'b.png' }, 'wan_vace', 'http://w1');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/upload?kind=wan_vace&worker=http%3A%2F%2Fw1');
  });

  it('uploadImage 缺省不带 worker 参数（M8 行为不变）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'a.png', worker: 'w1' }));
    await uploadImage({ uri: 'file:///tmp/a.png', fileName: 'a.png' }, 'img2img');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/upload?kind=img2img');
  });

  it.each([
    ['wan-animate', 'wan_animate'],
    ['wan-vace', 'wan_vace'],
    ['ltx25-i2v', 'ltx_i2v'],
    ['img2img', 'img2img'],
    ['txt2img', 'img2img'],
  ])('uploadKindForEngine(%s) → %s（对齐 Web GenerateView uploadKind 映射）', (engineId, kind) => {
    expect(uploadKindForEngine(engineId)).toBe(kind);
  });
});

describe('H3 / LongCat / ACE 引擎链路 API（M10）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m10');
  });

  it('submitH3T2V POST /api/h3/t2v 并序列化请求体（loras 数组原样透传）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 5 }),
    );
    const body = {
      positive: '海浪拍打礁石',
      negative: '低画质',
      width: 1344,
      height: 768,
      length: 124,
      steps: 20,
      seed: 42,
      loras: [
        { name: 'film.safetensors', strength: 0.6 },
        { name: 'motion.safetensors', strength: 0.85 },
      ],
    };
    const result = await submitH3T2V(body);
    expect(result).toEqual({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 5 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/h3/t2v');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m10');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitH3I2V POST /api/h3/i2v 并序列化请求体（含 image/worker + loras）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p2', client_id: 'c1', worker: 'w1', seed: 7 }),
    );
    const body = {
      positive: '让照片动起来',
      image: 'ref.png',
      worker: 'http://w1',
      width: 1344,
      height: 768,
      length: 124,
      steps: 20,
      loras: [{ name: 'film.safetensors', strength: 0.6 }],
    };
    await submitH3I2V(body);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/h3/i2v');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('H3 提交 422（loras 校验失败）展开首条 msg（对齐 M9 视频链路）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        detail: [
          { loc: ['body', 'loras', 0, 'name'], msg: 'LoRA 必须是 .safetensors 文件', type: 'value_error' },
        ],
      }),
    );
    await expect(
      submitH3T2V({ positive: 'a', loras: [{ name: 'bad.ckpt', strength: 0.6 }] }),
    ).rejects.toMatchObject({ status: 422, message: 'LoRA 必须是 .safetensors 文件' });
  });

  it('H3 R18 LoRA 门控 403 走兜底人话（主站无 X-NSFW 上下文）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(403, { detail: '所选 LoRA 为 R18 内容,仅限 NSFW 专区使用' }),
    );
    await expect(
      submitH3T2V({ positive: 'a', loras: [{ name: 'r18.safetensors', strength: 0.6 }] }),
    ).rejects.toMatchObject({ status: 403, message: '没有权限执行此操作' });
  });

  it('submitLongCatT2V POST /api/longcat/t2v 并序列化请求体（无 cfg，蒸馏链路）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p3', client_id: 'c1', worker: 'w1', seed: 11 }),
    );
    const body = {
      positive: '长镜头：城市日出延时',
      negative: '模糊',
      width: 832,
      height: 480,
      num_frames: 121,
      steps: 10,
      fps: 16,
      seed: 7,
    };
    const result = await submitLongCatT2V(body);
    expect(result).toEqual({ prompt_id: 'p3', client_id: 'c1', worker: 'w1', seed: 11 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/longcat/t2v');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitLongCatI2V POST /api/longcat/i2v 并序列化请求体（含 image/worker）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p4', client_id: 'c1', worker: 'w1', seed: 13 }),
    );
    const body = {
      positive: '首帧延展成长镜头',
      image: 'first.png',
      worker: 'http://w1',
      width: 832,
      height: 480,
      num_frames: 241,
      steps: 10,
      fps: 16,
    };
    await submitLongCatI2V(body);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/longcat/i2v');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitLongCatContinue POST /api/longcat/continue：video 产物 URL + 缺省宽高/帧率省略不传', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p5', client_id: 'c1', worker: 'w1', seed: 17 }),
    );
    const body = {
      positive: '续写下一段',
      video: '/api/images?path=ToIV_longcat/a.mp4',
      num_frames: 121,
      steps: 10,
    };
    await submitLongCatContinue(body);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/longcat/continue');
    expect(init.method).toBe('POST');
    // width/height/fps 缺省省略 → 后端 ffprobe 实测源视频对齐（routes/longcat_studio.py）
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitAceMusic POST /api/generate/audio 并序列化请求体（tags/lyrics/seconds/steps/cfg/seed）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p6', client_id: 'c1', worker: 'w1', seed: 19 }),
    );
    const body = {
      tags: 'lofi, chill, piano',
      lyrics: '[verse]\nla la la',
      seconds: 30,
      steps: 50,
      cfg: 5,
      seed: 23,
    };
    const result = await submitAceMusic(body);
    expect(result).toEqual({ prompt_id: 'p6', client_id: 'c1', worker: 'w1', seed: 19 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/generate/audio');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m10');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('M10 六个提交函数统一走长超时档（30s 不中止，180s 超时人话）', async () => {
    jest.useFakeTimers();
    try {
      const cases: [string, () => Promise<unknown>][] = [
        ['submitH3T2V', () => submitH3T2V({ positive: 'a' })],
        ['submitH3I2V', () => submitH3I2V({ positive: 'a', image: 'r.png', worker: 'w1' })],
        ['submitLongCatT2V', () => submitLongCatT2V({ positive: 'a' })],
        ['submitLongCatI2V', () => submitLongCatI2V({ positive: 'a', image: 'r.png', worker: 'w1' })],
        ['submitLongCatContinue', () => submitLongCatContinue({ positive: 'a', video: '/api/images?x' })],
        ['submitAceMusic', () => submitAceMusic({ tags: 'lofi' })],
      ];
      for (const [, invoke] of cases) {
        mockFetch.mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            }),
        );
        const pending = invoke();
        let rejected = false;
        void pending.catch(() => {
          rejected = true;
        });
        const assertion = expect(pending).rejects.toMatchObject({
          status: 0,
          message: '请求超时，请检查网络后重试',
        });
        // 常规档 30s 对长任务太短：不应中止（证明 long=true）
        await jest.advanceTimersByTimeAsync(30_000);
        expect(rejected).toBe(false);
        // 长档 180s 到点中止
        await jest.advanceTimersByTimeAsync(150_000);
        await assertion;
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['h3-i2v', 'h3_i2v'],
    ['longcat-i2v', 'ltx_i2v'],
    ['h3-t2v', 'img2img'],
    ['longcat-t2v', 'img2img'],
    ['longcat-continue', 'img2img'],
    ['ace-music', 'img2img'],
  ])('uploadKindForEngine(%s) → %s（M10 新增：h3 专用 kind；longcat-i2v 复用 ltx_i2v）', (engineId, kind) => {
    expect(uploadKindForEngine(engineId)).toBe(kind);
  });
});

describe('R18 视频引擎链路 API（M11）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m11');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('submitLtxNsfwT2V POST /api/generate/ltx-t2v 并序列化请求体（含 use_upscale/use_rife）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 5 }),
    );
    const body = {
      positive: '一段影像',
      negative: '低画质',
      width: 1280,
      height: 720,
      length: 89,
      fps: 16,
      steps: 20,
      cfg: 1,
      seed: 42,
      use_upscale: true,
      use_rife: false,
    };
    const result = await submitLtxNsfwT2V(body);
    expect(result).toEqual({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 5 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/generate/ltx-t2v');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m11');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitLtxNsfwI2V POST /api/generate/ltx-i2v 并序列化请求体（含 image/worker）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p2', client_id: 'c1', worker: 'w1', seed: 7 }),
    );
    const body = {
      positive: '让照片动起来',
      image: 'ref.png',
      worker: 'http://w1',
      width: 1280,
      height: 720,
      length: 89,
      fps: 16,
      steps: 20,
      cfg: 1,
      use_upscale: false,
      use_rife: false,
    };
    await submitLtxNsfwI2V(body);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/generate/ltx-i2v');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('submitLtxNsfwLipsync POST /api/generate/ltx-lipsync 并序列化请求体（含 audio/id_lora/id_lora_strength）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p3', client_id: 'c1', worker: 'w1', seed: 9 }),
    );
    const body = {
      positive: '对口型说话',
      image: 'face.png',
      audio: 'voice.wav',
      worker: 'http://w1',
      id_lora: 'identity.safetensors',
      id_lora_strength: 0.8,
      width: 1280,
      height: 720,
      length: 145,
      fps: 16,
      steps: 20,
      cfg: 1,
      use_upscale: false,
      use_rife: true,
    };
    await submitLtxNsfwLipsync(body);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/generate/ltx-lipsync');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('R18 提交 403（主站无 X-NSFW 上下文门控）走兜底人话', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(403, { detail: 'LTX 视频生成仅限 NSFW 专区访问' }),
    );
    await expect(submitLtxNsfwT2V({ positive: 'a' })).rejects.toMatchObject({
      status: 403,
      message: '没有权限执行此操作',
    });
  });

  it('R18 三个提交函数统一走长超时档（30s 不中止，180s 超时人话）', async () => {
    jest.useFakeTimers();
    try {
      const cases: [string, () => Promise<unknown>][] = [
        ['submitLtxNsfwT2V', () => submitLtxNsfwT2V({ positive: 'a' })],
        ['submitLtxNsfwI2V', () => submitLtxNsfwI2V({ positive: 'a', image: 'r.png', worker: 'w1' })],
        [
          'submitLtxNsfwLipsync',
          () => submitLtxNsfwLipsync({ positive: 'a', image: 'r.png', audio: 'v.wav', worker: 'w1' }),
        ],
      ];
      for (const [, invoke] of cases) {
        mockFetch.mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            }),
        );
        const pending = invoke();
        let rejected = false;
        void pending.catch(() => {
          rejected = true;
        });
        const assertion = expect(pending).rejects.toMatchObject({
          status: 0,
          message: '请求超时，请检查网络后重试',
        });
        // 常规档 30s 对长任务太短：不应中止（证明 long=true）
        await jest.advanceTimersByTimeAsync(30_000);
        expect(rejected).toBe(false);
        // 长档 180s 到点中止
        await jest.advanceTimersByTimeAsync(150_000);
        await assertion;
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('uploadAudio POST /api/upload?kind=ltx_lipsync&worker=<钉点>：字段名固定 image、三段式直传、不手设 Content-Type', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'voice.wav', worker: 'http://w1' }));
    const result = await uploadAudio(
      { uri: 'file:///tmp/voice.wav', fileName: 'voice.wav', mimeType: 'audio/wav' },
      'ltx_lipsync',
      'http://w1',
    );
    expect(result).toEqual({ filename: 'voice.wav', worker: 'http://w1' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/upload?kind=ltx_lipsync&worker=http%3A%2F%2Fw1');
    expect(init.method).toBe('POST');
    // multipart 边界由运行时生成，禁止手设 Content-Type
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m11');
    expect(init.body).toBeInstanceOf(FormData);
    // 音频同样挂在 image 字段（upload.py UploadFile 形参名）
    expect(appendSpy).toHaveBeenCalledWith('image', {
      uri: 'file:///tmp/voice.wav',
      name: 'voice.wav',
      type: 'audio/wav',
    });
  });

  it('uploadAudio 无钉点时 qs 仅 kind；fileName 缺失按 mimeType 推扩展名（x-m4a→m4a）', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { filename: 'a.m4a', worker: 'w1' }));
    await uploadAudio({ uri: 'file:///tmp/a', fileName: null, mimeType: 'audio/x-m4a' }, 'ltx_lipsync');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/upload?kind=ltx_lipsync');
    expect(appendSpy).toHaveBeenCalledWith('image', {
      uri: 'file:///tmp/a',
      name: 'upload.m4a',
      type: 'audio/x-m4a',
    });
  });

  it('uploadAudio 415（三重白名单拦截）透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(415, { detail: '不支持的文件类型:.exe' }));
    await expect(
      uploadAudio({ uri: 'file:///tmp/fake.mp3', fileName: 'fake.mp3' }, 'ltx_lipsync'),
    ).rejects.toMatchObject({ status: 415, message: '不支持的文件类型:.exe' });
  });

  it.each([
    ['ltx-nsfw-i2v', 'ltx_i2v'],
    ['ltx-nsfw-lipsync', 'ltx_lipsync'],
    ['h3-nsfw-i2v', 'h3_i2v'],
    ['ltx-nsfw-t2v', 'img2img'],
    ['h3-nsfw-t2v', 'img2img'],
  ])('uploadKindForEngine(%s) → %s（M11 R18 上传路由）', (engineId, kind) => {
    expect(uploadKindForEngine(engineId)).toBe(kind);
  });
});

describe('LongCat-Avatar 数字人链路 API（M14）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m14');
  });

  it('submitAvatarTalk POST /api/avatar/talk 并序列化请求体（image/audio/worker + 数值键）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { prompt_id: 'p4', client_id: 'c1', worker: 'w1', seed: 11 }),
    );
    const body = {
      positive: '开口介绍产品',
      image: 'face.png',
      audio: 'voice.wav',
      worker: 'http://w1',
      negative: '低画质',
      width: 480,
      height: 832,
      num_frames: 93,
      fps: 25,
      steps: 12,
      seed: 42,
    };
    const result = await submitAvatarTalk(body);
    expect(result).toEqual({ prompt_id: 'p4', client_id: 'c1', worker: 'w1', seed: 11 });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/avatar/talk');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m14');
  });

  it('submitAvatarTalk 走长超时档（>93 帧链式续段分钟级任务：30s 不中止，180s 超时人话）', async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );
      const pending = submitAvatarTalk({
        positive: 'a',
        image: 'f.png',
        audio: 'v.wav',
        worker: 'w1',
      });
      let rejected = false;
      void pending.catch(() => {
        rejected = true;
      });
      const assertion = expect(pending).rejects.toMatchObject({
        status: 0,
        message: '请求超时，请检查网络后重试',
      });
      // 常规档 30s 对长任务太短：不应中止（证明 long=true）
      await jest.advanceTimersByTimeAsync(30_000);
      expect(rejected).toBe(false);
      // 长档 180s 到点中止
      await jest.advanceTimersByTimeAsync(150_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('submitAvatarTalk 422（后端约束拦截）透传 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(422, { detail: '帧数须在 17-2500 之间' }));
    await expect(
      submitAvatarTalk({ positive: 'a', image: 'f.png', audio: 'v.wav', worker: 'w1' }),
    ).rejects.toMatchObject({ status: 422, message: '帧数须在 17-2500 之间' });
  });

  it.each([['avatar-talk', 'avatar']])(
    'uploadKindForEngine(%s) → %s（M14：人像图与驱动音频同落 pool worker 仅存文件，提交时后端转运 LongCat :8197）',
    (engineId, kind) => {
      expect(uploadKindForEngine(engineId)).toBe(kind);
    },
  );
});

describe('参考资产库 API（M13）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m13');
  });

  const sampleAsset = {
    id: 'as-1',
    kind: 'character',
    name: '女主-A',
    description: '银发蓝瞳',
    images: [
      { filename: 'a.png', worker: 'http://w1' },
      { filename: 'b.png', worker: 'http://w1' },
    ],
    nsfw: false,
    created_at: '2026-08-14T10:00:00',
    updated_at: '2026-08-14T10:00:00',
  };

  it('listAssets 缺省 kind 命中 GET /api/assets 并原样返回数组', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [sampleAsset]));
    const result = await listAssets();
    expect(result).toEqual([sampleAsset]);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/assets');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m13');
  });

  it('listAssets 带 kind 过滤时拼 ?kind= 查询串', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await listAssets('style');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/assets?kind=style');
  });

  it('createAsset POST /api/assets 并序列化请求体（kind/name/description/images/nsfw）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, sampleAsset));
    const body = {
      kind: 'character' as const,
      name: '女主-A',
      description: '银发蓝瞳',
      images: [
        { filename: 'a.png', worker: 'http://w1' },
        { filename: 'b.png', worker: 'http://w1' },
      ],
      nsfw: false,
    };
    const result = await createAsset(body);
    expect(result).toEqual(sampleAsset);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/assets');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('getAsset 命中 GET /api/assets/{id}，id 经 encodeURIComponent', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, sampleAsset));
    await getAsset('as/1');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/assets/as%2F1');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('updateAsset PATCH /api/assets/{id} 仅序列化 patch 中出现的字段', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { ...sampleAsset, name: '女主-B' }),
    );
    const result = await updateAsset('as-1', { name: '女主-B' });
    expect(result.name).toBe('女主-B');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/assets/as-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: '女主-B' });
  });

  it('deleteAsset 命中 DELETE /api/assets/{id}', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true, id: 'as-1' }));
    await deleteAsset('as-1');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/assets/as-1');
    expect(init.method).toBe('DELETE');
  });

  it('assetImageUrl 拼 /api/assets/{id}/images/{index} 并附 token（媒体标签走 query）', () => {
    expect(assetImageUrl('as-1', 0)).toBe(
      'https://api.test/api/assets/as-1/images/0?token=tk-m13',
    );
  });

  it('资产 404（他人资产 / nsfw 资产在 SFW 上下文防枚举）抛「资源不存在」人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { detail: '资产不存在' }));
    await expect(getAsset('ghost')).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });

  it('资产 422（name 超长 / images 超 4 张）展开 FastAPI 首条 msg', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        detail: [
          { loc: ['body', 'images'], msg: '参考图最多 4 张', type: 'value_error' },
        ],
      }),
    );
    await expect(
      createAsset({ kind: 'prop', name: 'x', images: [{ filename: 'a.png', worker: 'w1' }] }),
    ).rejects.toMatchObject({ status: 422, message: '参考图最多 4 张' });
  });
});

// ── 反推提示词（M17，契约已读 apps/api 源码验证：routes/reverse.py）──
describe('reversePrompt（M17）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    setNsfwIntent(false);
    await setToken('tk-m17');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POST /api/reverse：multipart 字段名 file（非 image），返回 kind/prompt/negative', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { kind: 'image', prompt: 'a cat sitting on a sofa', negative: 'blurry, watermark' }),
    );
    const res = await reversePrompt({
      uri: 'file:///tmp/local.png',
      fileName: 'local.png',
      mimeType: 'image/png',
    });
    expect(res).toEqual({
      kind: 'image',
      prompt: 'a cat sitting on a sofa',
      negative: 'blurry, watermark',
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/reverse');
    expect(init.method).toBe('POST');
    // multipart 边界由运行时生成，禁止手设 Content-Type
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m17');
    expect(init.body).toBeInstanceOf(FormData);
    expect(appendSpy).toHaveBeenCalledWith('file', {
      uri: 'file:///tmp/local.png',
      name: 'local.png',
      type: 'image/png',
    });
  });

  it('fileName 缺失时按 mimeType 推扩展名兜底（图片 jpg / 视频 mp4）', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { kind: 'image', prompt: 'x', negative: null }));
    await reversePrompt({ uri: 'file:///tmp/a', fileName: null, mimeType: 'image/webp' });
    expect(appendSpy).toHaveBeenCalledWith('file', {
      uri: 'file:///tmp/a',
      name: 'reverse.webp',
      type: 'image/webp',
    });

    appendSpy.mockClear();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { kind: 'video', prompt: 'y', negative: null }));
    await reversePrompt({ uri: 'file:///tmp/b', fileName: null, mimeType: 'video/quicktime' });
    expect(appendSpy).toHaveBeenCalledWith('file', {
      uri: 'file:///tmp/b',
      name: 'reverse.mov',
      type: 'video/quicktime',
    });
  });

  it('NSFW 意图开启时注入 X-NSFW 头（JoyCaption 专线触发条件）', async () => {
    setNsfwIntent(true);
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { kind: 'image', prompt: 'x', negative: null }));
    await reversePrompt({ uri: 'file:///tmp/n.png', fileName: 'n.png', mimeType: 'image/png' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-NSFW']).toBe('1');
  });

  it('SFW 默认不带 X-NSFW 头', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { kind: 'image', prompt: 'x', negative: null }));
    await reversePrompt({ uri: 'file:///tmp/s.png', fileName: 's.png', mimeType: 'image/png' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-NSFW']).toBeUndefined();
  });

  it('negative 缺省/null 归一化为 null（视频反推无负向词）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { kind: 'video', prompt: 'camera push in' }));
    const res = await reversePrompt({
      uri: 'file:///tmp/v.mp4',
      fileName: 'v.mp4',
      mimeType: 'video/mp4',
    });
    expect(res).toEqual({ kind: 'video', prompt: 'camera push in', negative: null });
  });

  it('413 文件过大透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(413, { detail: '文件过大(image 上限 20MB)' }));
    await expect(
      reversePrompt({ uri: 'file:///tmp/big.png', fileName: 'big.png', mimeType: 'image/png' }),
    ).rejects.toMatchObject({ status: 413, message: '文件过大(image 上限 20MB)' });
  });

  it('502 VLM 不可达 → 服务不可用人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(502, { detail: 'VLM 反推服务不可达' }));
    await expect(
      reversePrompt({ uri: 'file:///tmp/x.png', fileName: 'x.png', mimeType: 'image/png' }),
    ).rejects.toMatchObject({ status: 502, message: '服务暂时不可用，请稍后重试' });
  });
});

describe('optimizePrompt（M18）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    setNsfwIntent(false);
    await setToken('tk-m18');
  });

  it('POST /api/optimize 带 prompt+kind，返回 optimized/negative', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        optimized: 'masterpiece, best quality, a cat sitting on a sofa, soft light',
        negative: 'blurry, watermark, bad anatomy',
      }),
    );
    const res = await optimizePrompt({ prompt: '一只猫坐在沙发上', kind: 'image' });
    expect(res).toEqual({
      optimized: 'masterpiece, best quality, a cat sitting on a sofa, soft light',
      negative: 'blurry, watermark, bad anatomy',
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/optimize');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m18');
    expect(JSON.parse(init.body as string)).toEqual({ prompt: '一只猫坐在沙发上', kind: 'image' });
  });

  it('kind 跟随引擎直通（audio 单段类无 negative → 归一化 null）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { optimized: 'lofi, chill, piano, warm, 90bpm' }));
    const res = await optimizePrompt({ prompt: '放松的音乐', kind: 'audio' });
    expect(res).toEqual({ optimized: 'lofi, chill, piano, warm, 90bpm', negative: null });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ prompt: '放松的音乐', kind: 'audio' });
  });

  it('video 类返回 negative（视频引擎吃负向词）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        optimized: 'a cat walking, slow pan, cinematic lighting',
        negative: 'blurry, flickering, morphing',
      }),
    );
    const res = await optimizePrompt({ prompt: '猫走路', kind: 'video' });
    expect(res.negative).toBe('blurry, flickering, morphing');
  });

  it('negative 显式 null 归一化保持 null', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { optimized: 'x', negative: null }),
    );
    const res = await optimizePrompt({ prompt: 'x', kind: 'image' });
    expect(res).toEqual({ optimized: 'x', negative: null });
  });

  it('502 优化失败 → 服务不可用人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(502, { detail: '优化失败,请重试' }));
    await expect(optimizePrompt({ prompt: 'x', kind: 'image' })).rejects.toMatchObject({
      status: 502,
      message: '服务暂时不可用，请稍后重试',
    });
  });

  it('503 LLM 不可达 → 服务不可用人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(503, { detail: 'LLM 层全部不可用' }));
    await expect(optimizePrompt({ prompt: 'x', kind: 'image' })).rejects.toMatchObject({
      status: 503,
      message: '服务暂时不可用，请稍后重试',
    });
  });
});

// ── 对话助手（M19，契约已读 apps/api/app/routes/agent.py 源码验证）──

const mockExpoFetch = expoFetch as jest.Mock;
const sseEncoder = new TextEncoder();

/** 构造 expo/fetch 形状的 SSE 响应（ReadableStream body + X-Agent-Session-Id 头） */
function sseChatResponse(sessionId: string, frames: { event: string; data: string }[]) {
  const text = frames.map((f) => `event: ${f.event}\r\ndata: ${f.data}\r\n\r\n`).join('');
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) => (k === 'X-Agent-Session-Id' ? sessionId : null),
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseEncoder.encode(text));
        controller.close();
      },
    }),
    json: async () => ({}),
  };
}

describe('agentChatStream（M19.1）', () => {
  beforeEach(async () => {
    mockExpoFetch.mockReset();
    setNsfwIntent(false);
    await setToken('tk-m19');
  });

  it('POST /api/agent/chat：请求形状 + Accept/Authorization 头 + 响应头会话 id 透出', async () => {
    mockExpoFetch.mockResolvedValueOnce(
      sseChatResponse('sess-1', [{ event: 'done', data: '{}' }]),
    );
    const events: unknown[] = [];
    const res = await agentChatStream(
      { messages: [{ role: 'user', content: '画一只猫' }] },
      (e) => events.push(e),
    );
    expect(res).toEqual({ sessionId: 'sess-1' });
    const [url, init] = mockExpoFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.test/api/agent/chat');
    expect(init.method).toBe('POST');
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer tk-m19');
    // 无 sessionId：body 不带 session_id 键（后端空=新会话）
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: 'user', content: '画一只猫' }] });
  });

  it('续聊：sessionId 注入 body.session_id', async () => {
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('sess-9', [{ event: 'done', data: '{}' }]));
    await agentChatStream(
      { messages: [{ role: 'user', content: '再来一张' }], sessionId: 'sess-9' },
      () => undefined,
    );
    const [, init] = mockExpoFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      messages: [{ role: 'user', content: '再来一张' }],
      session_id: 'sess-9',
    });
  });

  it('M20：documentIds 非空注入 body.document_ids（挂载文档随轮上行）', async () => {
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('s', [{ event: 'done', data: '{}' }]));
    await agentChatStream(
      { messages: [{ role: 'user', content: '总结这份文档' }], documentIds: ['d1', 'd2'] },
      () => undefined,
    );
    const [, init] = mockExpoFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      messages: [{ role: 'user', content: '总结这份文档' }],
      document_ids: ['d1', 'd2'],
    });
  });

  it('M20：documentIds 缺省/空数组不带 document_ids 字段（对齐后端 default_factory=list）', async () => {
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('s', [{ event: 'done', data: '{}' }]));
    await agentChatStream({ messages: [{ role: 'user', content: 'x' }], documentIds: [] }, () => undefined);
    const [, init] = mockExpoFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: 'user', content: 'x' }] });
  });

  it('M30：image 注入 body.image（{filename,worker} 上传句柄随轮上行）', async () => {
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('s', [{ event: 'done', data: '{}' }]));
    await agentChatStream(
      {
        messages: [{ role: 'user', content: '把这张图改成夜景' }],
        image: { filename: 'up-cat.png', worker: 'http://w1' },
      },
      () => undefined,
    );
    const [, init] = mockExpoFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      messages: [{ role: 'user', content: '把这张图改成夜景' }],
      image: { filename: 'up-cat.png', worker: 'http://w1' },
    });
  });

  it('M30：image 可与 document_ids 同发；缺省不带 image 字段', async () => {
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('s', [{ event: 'done', data: '{}' }]));
    await agentChatStream(
      {
        messages: [{ role: 'user', content: 'x' }],
        documentIds: ['d1'],
        image: { filename: 'a.png', worker: 'w' },
      },
      () => undefined,
    );
    const [, init] = mockExpoFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      messages: [{ role: 'user', content: 'x' }],
      document_ids: ['d1'],
      image: { filename: 'a.png', worker: 'w' },
    });
    // 缺省语义由本 describe 首个用例的精确 body 断言钉死（仅 messages 键）
  });

  it('NSFW 意图注入 X-NSFW 头（专区内会话打标）', async () => {
    setNsfwIntent(true);
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('s', [{ event: 'done', data: '{}' }]));
    await agentChatStream({ messages: [{ role: 'user', content: 'x' }] }, () => undefined);
    const [, init] = mockExpoFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['X-NSFW']).toBe('1');
  });

  it('msg 帧 JSON 解析回调 text/tool/image 三类，done 帧不回调', async () => {
    mockExpoFetch.mockResolvedValueOnce(
      sseChatResponse('sess-2', [
        { event: 'msg', data: JSON.stringify({ type: 'text', content: '好的' }) },
        { event: 'msg', data: JSON.stringify({ type: 'tool', name: 'generate_image', args: { prompt: 'cat' } }) },
        { event: 'msg', data: JSON.stringify({ type: 'image', urls: ['/media/a.png'] }) },
        { event: 'done', data: '{}' },
      ]),
    );
    const events: { type: string }[] = [];
    await agentChatStream({ messages: [{ role: 'user', content: 'x' }] }, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'image']);
  });

  it('单帧坏 JSON 跳过不中断，后续事件正常回调', async () => {
    mockExpoFetch.mockResolvedValueOnce(
      sseChatResponse('sess-3', [
        { event: 'msg', data: '{broken' },
        { event: 'msg', data: JSON.stringify({ type: 'text', content: '幸存' }) },
        { event: 'done', data: '{}' },
      ]),
    );
    const events: unknown[] = [];
    await agentChatStream({ messages: [{ role: 'user', content: 'x' }] }, (e) => events.push(e));
    expect(events).toEqual([{ type: 'text', content: '幸存' }]);
  });

  it('HTTP 401 → ApiError 登录人话（错误体走 readErrorDetail 同一套）', async () => {
    mockExpoFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
      body: null,
      json: async () => ({ detail: 'expired' }),
    });
    await expect(
      agentChatStream({ messages: [{ role: 'user', content: 'x' }] }, () => undefined),
    ).rejects.toMatchObject({ status: 401, message: expect.stringContaining('登录') });
  });

  it('网络层异常 → ApiError(0) 网络人话', async () => {
    mockExpoFetch.mockRejectedValueOnce(new TypeError('network down'));
    await expect(
      agentChatStream({ messages: [{ role: 'user', content: 'x' }] }, () => undefined),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('无流式 body（web 回落环境）→ 协议级 ApiError(0)', async () => {
    mockExpoFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'sess-x' },
      body: null,
      json: async () => ({}),
    });
    await expect(
      agentChatStream({ messages: [{ role: 'user', content: 'x' }] }, () => undefined),
    ).rejects.toMatchObject({ status: 0, message: expect.stringContaining('流式') });
  });

  it('开始前已 aborted：fetch 拒绝 → 静默返回空 sessionId 不抛错', async () => {
    const controller = new AbortController();
    controller.abort();
    mockExpoFetch.mockRejectedValueOnce(new Error('The operation was aborted'));
    const res = await agentChatStream(
      { messages: [{ role: 'user', content: 'x' }] },
      () => undefined,
      controller.signal,
    );
    expect(res).toEqual({ sessionId: '' });
  });
});

describe('agent 会话管理（M19.1）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m19');
  });

  it('listAgentSessions：GET /api/agent/sessions 原样返回', async () => {
    const sessions = [
      {
        id: 's1',
        title: '画猫',
        nsfw: false,
        created_at: '2026-08-14T10:00:00',
        updated_at: '2026-08-14T11:00:00',
        message_count: 4,
      },
    ];
    mockFetch.mockResolvedValueOnce(jsonResponse(200, sessions));
    const res = await listAgentSessions();
    expect(res).toEqual(sessions);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent/sessions');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('getAgentSession：GET /api/agent/sessions/{id}（id 转义）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 's/1',
        title: 't',
        nsfw: false,
        created_at: '2026-08-14T10:00:00',
        updated_at: '2026-08-14T11:00:00',
        message_count: 1,
        messages: [
          {
            id: 1,
            role: 'user',
            content: '你好',
            tool_calls: null,
            media: [],
            created_at: '2026-08-14T10:00:00',
          },
        ],
      }),
    );
    const res = await getAgentSession('s/1');
    expect(res.messages).toHaveLength(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/agent/sessions/s%2F1');
  });

  it('deleteAgentSession：DELETE /api/agent/sessions/{id}', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await deleteAgentSession('s1');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent/sessions/s1');
    expect(init.method).toBe('DELETE');
  });

  it('会话 404（他人/R18 会话不泄露存在性）→ 资源不存在人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { detail: '会话不存在' }));
    await expect(getAgentSession('ghost')).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});

// ── 分叉会话（M24.1，契约已读 apps/api/app/routes/agent.py fork_agent_session 源码验证）──

describe('forkAgentSession（M24.1 分叉会话）', () => {
  const forked = {
    id: 's2',
    title: '画猫记录',
    nsfw: false,
    created_at: '2026-08-15T10:00:00',
    updated_at: '2026-08-15T10:00:00',
    message_count: 3,
  };

  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m24');
  });

  it('全量分叉：POST /api/agent/sessions/{sid}/fork，不带 body，返回会话摘要', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, forked));
    const res = await forkAgentSession('s1');
    expect(res).toEqual(forked);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent/sessions/s1/fork');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m24');
  });

  it('截断分叉：atMessageId 有值时 body 为 {at_message_id}（JSON）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, forked));
    await forkAgentSession('s1', 42);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ at_message_id: 42 });
  });

  it('sid 路径转义（特殊字符不破坏路由）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, forked));
    await forkAgentSession('s/1');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/agent/sessions/s%2F1/fork');
  });

  it('at_message_id 不在会话内 → 404 资源人话透传', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { detail: '消息不存在' }));
    await expect(forkAgentSession('s1', 999)).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});

// ── 文档挂载（M20.1，契约已读 apps/api/app/routes/documents.py 源码验证）──

describe('docs 文档挂载（M20.1）', () => {
  const docPayload = {
    id: 'd1',
    filename: '产品需求.pdf',
    kind: 'pdf',
    size: 2048,
    chunk_count: 6,
    status: 'ready',
    created_at: '2026-08-14T12:00:00',
  };

  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m20');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('listDocs：GET /api/docs 原样返回（created_at 倒序由后端保证）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [docPayload]));
    const res = await listDocs();
    expect(res).toEqual([docPayload]);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/docs');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m20');
  });

  it('uploadDoc：POST /api/docs/upload multipart 字段名 file、三段式直传、不手设 Content-Type，201 返回 DocItem', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(201, docPayload));
    const res = await uploadDoc({
      uri: 'file:///tmp/prd.pdf',
      fileName: '产品需求.pdf',
      mimeType: 'application/pdf',
    });
    expect(res).toEqual(docPayload);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/docs/upload');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m20');
    expect(init.body).toBeInstanceOf(FormData);
    expect(appendSpy).toHaveBeenCalledWith('file', {
      uri: 'file:///tmp/prd.pdf',
      name: '产品需求.pdf',
      type: 'application/pdf',
    });
  });

  it('uploadDoc：fileName 缺失按 mimeType 推扩展名兜底（docx→document.docx）', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(jsonResponse(201, docPayload));
    await uploadDoc({
      uri: 'file:///tmp/a',
      fileName: null,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(appendSpy).toHaveBeenCalledWith('file', {
      uri: 'file:///tmp/a',
      name: 'document.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('uploadDoc 400（类型不支持）透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { detail: '仅支持 pdf / docx / txt / md 文件' }));
    await expect(
      uploadDoc({ uri: 'file:///tmp/x.exe', fileName: 'x.exe', mimeType: 'application/octet-stream' }),
    ).rejects.toMatchObject({ status: 400, message: '仅支持 pdf / docx / txt / md 文件' });
  });

  it('uploadDoc 413（>50MB）透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(413, { detail: '文件超过 50MB 上限' }));
    await expect(
      uploadDoc({ uri: 'file:///tmp/big.pdf', fileName: 'big.pdf', mimeType: 'application/pdf' }),
    ).rejects.toMatchObject({ status: 413, message: '文件超过 50MB 上限' });
  });

  it('uploadDoc 422（解析失败/空文本）透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(422, { detail: '未能从文件中提取到文本内容' }));
    await expect(
      uploadDoc({ uri: 'file:///tmp/empty.txt', fileName: 'empty.txt', mimeType: 'text/plain' }),
    ).rejects.toMatchObject({ status: 422, message: '未能从文件中提取到文本内容' });
  });

  it('deleteDoc：DELETE /api/docs/{id}（id 转义）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await deleteDoc('d/1');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/docs/d%2F1');
    expect(init.method).toBe('DELETE');
  });

  it('deleteDoc 404（他人文档不泄露存在性）→ 资源不存在人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { detail: '文档不存在' }));
    await expect(deleteDoc('ghost')).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});

// ── Agent 团队运行监控（M21.1，契约已读 apps/api routes/agent_team.py / services/agent_team_exec.py 源码验证）──

describe('agent 团队运行 REST（M21.1）', () => {
  const runSummary = {
    id: 'run-1',
    level: 'L1',
    goal: '做一个宣传片',
    status: 'running',
    created_at: '2026-08-15T08:00:00',
    task_counts: { total: 6, done: 2, error: 0 },
  };

  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m21');
  });

  it('listAgentRuns：缺省 ?limit=50，带 Authorization', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [runSummary]));
    const res = await listAgentRuns();
    expect(res).toEqual([runSummary]);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent-runs?limit=50');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m21');
  });

  it('listAgentRuns：status 精确匹配拼查询（awaiting_confirm 需编码）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await listAgentRuns('awaiting_confirm');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/agent-runs?limit=50&status=awaiting_confirm');
  });

  it('getAgentRun：路径 id 转义', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'r/1',
        goal: 'g',
        level: 'L1',
        status: 'done',
        error: '',
        plan: [],
        created_at: '2026-08-15T08:00:00',
        updated_at: '2026-08-15T08:10:00',
      }),
    );
    await getAgentRun('r/1');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/agent-runs/r%2F1');
  });

  it('cancelAgentRun：POST /cancel 返回终态；409 透传后端 detail 人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { run_id: 'run-1', status: 'canceled' }));
    const res = await cancelAgentRun('run-1');
    expect(res).toEqual({ run_id: 'run-1', status: 'canceled' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent-runs/run-1/cancel');
    expect(init.method).toBe('POST');

    mockFetch.mockResolvedValueOnce(jsonResponse(409, { detail: '运行已结束，无法取消' }));
    await expect(cancelAgentRun('run-1')).rejects.toMatchObject({
      status: 409,
      message: '运行已结束，无法取消',
    });
  });
});

// ── Agent 团队二期交互（M22：确认门裁决 resume + 卡片干预 task action）──

describe('resumeAgentRun（M22 确认门裁决）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m22');
  });

  it('POST /resume：URL + gate/action/feedback body 契约 + Authorization', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { run_id: 'run-1', status: 'running' }));
    const res = await resumeAgentRun('run-1', {
      gate: 'assembly',
      action: 'reject',
      feedback: '片头节奏太慢',
    });
    expect(res).toEqual({ run_id: 'run-1', status: 'running' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent-runs/run-1/resume');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m22');
    expect(JSON.parse(init.body as string)).toEqual({
      gate: 'assembly',
      action: 'reject',
      feedback: '片头节奏太慢',
    });
  });

  it('feedback 缺省时 body 不带该字段；runId 路径编码', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { run_id: 'r/1', status: 'running' }));
    await resumeAgentRun('r/1', { gate: 'plan', action: 'approve' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent-runs/r%2F1/resume');
    expect(JSON.parse(init.body as string)).toEqual({ gate: 'plan', action: 'approve' });
  });

  it('409 状态不符 → 后端 detail 人话透传', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, { detail: '当前状态(running)不可操作计划确认门' }),
    );
    await expect(
      resumeAgentRun('run-1', { gate: 'plan', action: 'approve' }),
    ).rejects.toMatchObject({ status: 409, message: '当前状态(running)不可操作计划确认门' });
  });
});

describe('agentTaskAction（M22 卡片干预）', () => {
  const task = {
    id: 't1',
    kind: 'script',
    title: '旁白脚本',
    depends_on: [],
    status: 'pending',
    attempt: 1,
    input: { prompt: '雨夜，女主回头' },
    output: {},
    verdict: {},
    gpu_hint: '',
  };

  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m22');
  });

  it('POST /tasks/{tid}/action：runId/taskId 双段路径编码 + body 原样透传', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, task));
    const res = await agentTaskAction('r/1', 't/1', { action: 'approve' });
    expect(res).toEqual(task);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent-runs/r%2F1/tasks/t%2F1/action');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'approve' });
  });

  it('edit：payload={input:{...}} 原样透传，返回卡片顶层字段（无包装）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, task));
    const res = await agentTaskAction('run-1', 't1', {
      action: 'edit',
      payload: { input: { prompt: '雨夜，女主回头' } },
    });
    expect(res.status).toBe('pending');
    expect(res.input).toEqual({ prompt: '雨夜，女主回头' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'edit',
      payload: { input: { prompt: '雨夜，女主回头' } },
    });
  });

  it('regenerate：guidance 引导词透传 payload；409 非 done/error 人话透传', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ...task, attempt: 2 }));
    await agentTaskAction('run-1', 't1', {
      action: 'regenerate',
      payload: { guidance: '节奏加快' },
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'regenerate',
      payload: { guidance: '节奏加快' },
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, { detail: '仅已完成/失败的任务可重生成' }),
    );
    await expect(
      agentTaskAction('run-1', 't1', { action: 'regenerate' }),
    ).rejects.toMatchObject({ status: 409, message: '仅已完成/失败的任务可重生成' });
  });

  it('400 合成卡走合成门 → 人话透传', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(400, { detail: '合成任务请走合成确认门' }),
    );
    await expect(
      agentTaskAction('run-1', 't9', { action: 'regenerate' }),
    ).rejects.toMatchObject({ status: 400, message: '合成任务请走合成确认门' });
  });

  it('reprompt：无 payload 字段，返回卡片 input 已写回反推 prompt（M33）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        ...task,
        status: 'done',
        input: { prompt: 'reversed cinematic prompt', negative: 'blurry' },
      }),
    );
    const res = await agentTaskAction('run-1', 't1', { action: 'reprompt' });
    expect(res.status).toBe('done');
    expect(res.input.prompt).toBe('reversed cinematic prompt');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ action: 'reprompt' });
  });
});

// ── Agent 团队四期（M33：卡片产物直传替换 POST .../tasks/{tid}/upload multipart）──

describe('uploadAgentTaskAsset（M33 替换上传）', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m33');
  });

  it('POST multipart：双段路径编码 + 字段名 file + RN 三段式 + 不手设 Content-Type', async () => {
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 't/1',
        kind: 'video',
        status: 'done',
        output: { url: '/api/studio/files/u1.mp4', source: 'upload' },
      }),
    );
    const res = await uploadAgentTaskAsset('r/1', 't/1', {
      uri: 'file:///tmp/replacement.mp4',
      fileName: 'replacement.mp4',
      mimeType: 'video/mp4',
    });
    expect(res.output).toMatchObject({ source: 'upload' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent-runs/r%2F1/tasks/t%2F1/upload');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m33');
    expect(init.body).toBeInstanceOf(FormData);
    expect(appendSpy).toHaveBeenCalledWith('file', {
      uri: 'file:///tmp/replacement.mp4',
      name: 'replacement.mp4',
      type: 'video/mp4',
    });
    appendSpy.mockRestore();
  });

  it('415 魔数不符 → 人话透传', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(415, { detail: '文件内容与扩展名不符' }),
    );
    await expect(
      uploadAgentTaskAsset('run-1', 't1', {
        uri: 'file:///tmp/fake.png',
        fileName: 'fake.png',
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ status: 415, message: '文件内容与扩展名不符' });
  });
});

// ── Agent 团队三期交互（M23：计划编辑 POST /plan + 成片结果 GET /result）──

describe('updateAgentRunPlan（M23 计划编辑）', () => {
  const resp = {
    run_id: 'run-1',
    plan: {
      tasks: [
        { id: 't1', kind: 'image', title: '主视觉改', depends_on: [], status: 'pending' },
        { id: 'new-1', kind: 'video', title: '补拍空镜', depends_on: [], status: 'pending' },
      ],
    },
  };

  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m23');
  });

  it('POST /plan：URL + body {tasks:ops} 契约 + Authorization + 返回 {run_id, plan.tasks}', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, resp));
    const ops = [
      { id: 't1', action: 'update' as const, title: '主视觉改', input: { prompt: '新文案' } },
      { id: 't2', action: 'remove' as const },
      { id: 'new-1', action: 'add' as const, title: '补拍空镜', input: { prompt: '雨夜空镜' } },
    ];
    const res = await updateAgentRunPlan('run-1', ops);
    expect(res).toEqual(resp);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent-runs/run-1/plan');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m23');
    expect(JSON.parse(init.body as string)).toEqual({ tasks: ops });
  });

  it('runId 路径编码', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { run_id: 'r/1', plan: { tasks: [] } }),
    );
    await updateAgentRunPlan('r/1', [{ id: 't1', action: 'remove' }]);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/agent-runs/r%2F1/plan');
  });

  it('409 非待确认 → 后端 detail 人话透传', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, { detail: '仅待确认状态可编辑计划' }),
    );
    await expect(
      updateAgentRunPlan('run-1', [{ id: 't1', action: 'update', title: 'x' }]),
    ).rejects.toMatchObject({ status: 409, message: '仅待确认状态可编辑计划' });
  });

  it('404 任务不存在 → 资源不存在人话', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { detail: '任务不存在:t9' }));
    await expect(
      updateAgentRunPlan('run-1', [{ id: 't9', action: 'remove' }]),
    ).rejects.toMatchObject({ status: 404, message: '资源不存在或已被清理' });
  });
});

describe('getAgentRunResult（M23 成片结果）', () => {
  const resp = {
    final_url: '/media/final.mp4',
    duration_sec: 12,
    tasks: [
      { id: 't1', title: '镜头一', kind: 'video', status: 'done', output: { url: '/media/a.mp4' } },
      { id: 't2', title: '镜头二', kind: 'video', status: 'approved', output: { url: '/media/b.mp4' } },
      {
        id: 't9',
        title: '合成成片',
        kind: 'assemble',
        status: 'done',
        output: { url: '/media/final.mp4' },
      },
    ],
  };

  beforeEach(async () => {
    mockFetch.mockReset();
    await setToken('tk-m23');
  });

  it('GET /result：URL + 返回形状 {final_url, duration_sec, tasks} 原样透传', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, resp));
    const res = await getAgentRunResult('run-1');
    expect(res).toEqual(resp);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/agent-runs/run-1/result');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-m23');
  });

  it('runId 路径编码；final_url 空串为合法值（合成产物缺失）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { final_url: '', duration_sec: 0, tasks: [] }),
    );
    const res = await getAgentRunResult('r/1');
    expect(res.final_url).toBe('');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/api/agent-runs/r%2F1/result');
  });

  it('409 未完成 → 后端 detail 人话透传', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(409, { detail: '任务尚未完成' }));
    await expect(getAgentRunResult('run-1')).rejects.toMatchObject({
      status: 409,
      message: '任务尚未完成',
    });
  });
});

describe('watchAgentRunEvents（M21.1 SSE 事件流）', () => {
  beforeEach(async () => {
    mockExpoFetch.mockReset();
    await setToken('tk-m21');
  });

  it('GET /events：after 游标 + token query 双通道 + Authorization/Accept 头', async () => {
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('', [{ event: 'ack', data: '{"message":"已接单","level":"L1"}' }]));
    await watchAgentRunEvents('run-1', 7, () => undefined);
    const [url, init] = mockExpoFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.test/api/agent-runs/run-1/events?after=7&token=tk-m21');
    expect(init.method).toBe('GET');
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(init.headers.Authorization).toBe('Bearer tk-m21');
  });

  it('无 token 时 query 不带 token 键也不带 Authorization 头', async () => {
    await setToken(null);
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('', []));
    await watchAgentRunEvents('run-1', 0, () => undefined);
    const [url, init] = mockExpoFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.test/api/agent-runs/run-1/events?after=0');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('after 负值/小数防御归零取整', async () => {
    mockExpoFetch.mockResolvedValueOnce(sseChatResponse('', []));
    await watchAgentRunEvents('run-1', -3.7, () => undefined);
    const [url] = mockExpoFetch.mock.calls[0] as [string];
    expect(url).toContain('after=0');
  });

  it('事件帧经 toAgentRunEvent 守卫回调；未知事件名/坏 JSON 跳过不中断', async () => {
    mockExpoFetch.mockResolvedValueOnce(
      sseChatResponse('', [
        { event: 'ack', data: JSON.stringify({ message: '已接单', level: 'L1' }) },
        { event: 'task_status', data: JSON.stringify({ task_id: 't1', status: 'running', title: '生成图' }) },
        { event: 'blocked', data: JSON.stringify({ task_id: 't1', title: '生成图', error: '显存不足' }) },
        { event: 'verdict', data: '{"verdict":"通过"}' }, // 后端本期不发，未知类型跳过
        { event: 'task_status', data: '{broken' }, // 坏 JSON 跳过
        { event: 'error', data: JSON.stringify({ message: '流水线异常' }) },
      ]),
    );
    const events: { type: string }[] = [];
    await watchAgentRunEvents('run-1', 0, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(['ack', 'task_status', 'blocked', 'error']);
  });

  it('404（他人/不存在）→ ApiError 资源不存在人话', async () => {
    mockExpoFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => null },
      body: null,
      json: async () => ({ detail: '任务不存在' }),
    });
    await expect(watchAgentRunEvents('ghost', 0, () => undefined)).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });

  it('网络层异常 → ApiError(0) 网络人话', async () => {
    mockExpoFetch.mockRejectedValueOnce(new TypeError('network down'));
    await expect(watchAgentRunEvents('run-1', 0, () => undefined)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('网络'),
    });
  });

  it('无流式 body（web 回落环境）→ 协议级 ApiError(0)', async () => {
    mockExpoFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      json: async () => ({}),
    });
    await expect(watchAgentRunEvents('run-1', 0, () => undefined)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('流式'),
    });
  });

  it('开始前已 aborted：fetch 拒绝 → 静默返回不抛错', async () => {
    const controller = new AbortController();
    controller.abort();
    mockExpoFetch.mockRejectedValueOnce(new Error('The operation was aborted'));
    await expect(
      watchAgentRunEvents('run-1', 0, () => undefined, controller.signal),
    ).resolves.toBeUndefined();
  });
});
