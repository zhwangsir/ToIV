import { beforeEach, describe, expect, it } from 'vitest';

import {
  deleteDoc,
  cancelJob,
  deleteJob,
  fetchEngines,
  fetchMe,
  fetchVersions,
  listDocs,
  listJobs,
  login,
  logout,
  optimizePrompt,
  rerunJob,
  reversePrompt,
  submitAceMusic,
  submitAvatarTalk,
  submitH3I2V,
  submitH3MultiShot,
  submitH3T2V,
  submitImg2Img,
  submitKeyframeChain,
  submitLongCatContinue,
  submitLongCatI2V,
  submitLongCatT2V,
  submitLtxNsfwI2V,
  submitLtxNsfwLipsync,
  submitLtxNsfwT2V,
  submitQwenEdit,
  submitTxt2Img,
  submitVaceEdit,
  submitWanAnimate,
  submitWanAnimate2,
  submitWanNsfwI2V,
  submitWanTransition,
  submitWanVace,
  uploadAudio,
  uploadDoc,
  uploadImage,
  uploadVideo,
} from '@/api';
import { getToken, LONG_TIMEOUT_MS, setNsfwIntent, setToken } from '@/api/client';
import { setApiBaseOverride } from '@/api/config';
import {
  enqueueResponse,
  installMockUni,
  lastRequest,
  lastUpload,
  setUploadResult,
} from './helpers/mock-uni';

beforeEach(() => {
  installMockUni();
  setToken(null);
  setApiBaseOverride(null);
  setNsfwIntent(false);
});

describe('login', () => {
  it('成功：存 token 并返回用户', async () => {
    enqueueResponse(200, { token: 'tk-1', user: { id: 'u1', email: 'a@b.c', role: 'user' } });
    const res = await login('a@b.c', 'pw');
    expect(res.token).toBe('tk-1');
    expect(getToken()).toBe('tk-1');
    expect(lastRequest().url).toContain('/api/auth/login');
    expect(lastRequest().data).toEqual({ email: 'a@b.c', password: 'pw' });
  });

  it('协议守卫：缺 token 字段抛协议错误', async () => {
    enqueueResponse(200, { access_token: 'legacy', user: {} });
    await expect(login('a@b.c', 'pw')).rejects.toMatchObject({
      status: 0,
      message: '登录响应缺少 token 字段（协议不符）',
    });
    expect(getToken()).toBeNull();
  });
});

describe('logout', () => {
  it('清除 token', () => {
    setToken('tk');
    logout();
    expect(getToken()).toBeNull();
  });
});

describe('fetchMe', () => {
  it('GET /api/auth/me', async () => {
    enqueueResponse(200, { user: { id: 'u1', email: 'a@b.c', role: 'user' } });
    const me = await fetchMe();
    expect(me.user.id).toBe('u1');
    expect(lastRequest().url).toContain('/api/auth/me');
  });
});

describe('fetchEngines', () => {
  it('解包 engines 数组', async () => {
    enqueueResponse(200, { engines: [{ id: 'sdxl', label: 'SDXL' }], count: 1 });
    const engines = await fetchEngines();
    expect(engines).toHaveLength(1);
    expect(engines[0].id).toBe('sdxl');
    expect(lastRequest().url).toContain('/api/models/engines');
  });

  it('缺 engines 字段回落空数组', async () => {
    enqueueResponse(200, {});
    expect(await fetchEngines()).toEqual([]);
  });
});

describe('generate', () => {
  it('submitTxt2Img POST 到 txt2img 端点', async () => {
    enqueueResponse(200, { prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 42 });
    const res = await submitTxt2Img({ positive: 'a cat' });
    expect(res.prompt_id).toBe('p1');
    expect(lastRequest().url).toContain('/api/generate/txt2img');
    expect(lastRequest().data).toEqual({ positive: 'a cat' });
  });

  it('submitImg2Img POST 到 img2img 端点且带 image/worker', async () => {
    enqueueResponse(200, { prompt_id: 'p2', client_id: 'c1', worker: 'w1', seed: 1 });
    await submitImg2Img({ positive: 'x', image: 'f.png', worker: 'w1' });
    expect(lastRequest().url).toContain('/api/generate/img2img');
    expect(lastRequest().data).toMatchObject({ image: 'f.png', worker: 'w1' });
  });
});

describe('uploadImage', () => {
  it('multipart 上传，字段名 image，kind 走 query', async () => {
    setToken('tk');
    setUploadResult(200, { filename: 'f.png', worker: 'w1' });
    const res = await uploadImage('/tmp/local.png');
    expect(res).toEqual({ filename: 'f.png', worker: 'w1' });
    const call = lastUpload();
    expect(call.url).toContain('/api/upload?kind=img2img');
    expect(call.name).toBe('image');
    expect(call.header.Authorization).toBe('Bearer tk');
  });

  it('pinWorker 追加 worker query（wan-vace 第 2-4 张钉第一张）', async () => {
    setUploadResult(200, { filename: 'b.png', worker: 'w1' });
    await uploadImage('/tmp/b.png', 'wan_vace', 'w1');
    expect(lastUpload().url).toContain('/api/upload?kind=wan_vace&worker=w1');
  });
});

// ── MP17：反推提示词（POST /api/reverse，契约已读 apps/api/app/routes/reverse.py）──
describe('reversePrompt', () => {
  it('multipart 上传，字段名 file（非 image），返回 kind/prompt/negative', async () => {
    setToken('tk');
    setUploadResult(200, { kind: 'image', prompt: 'a cat sitting on a sofa', negative: 'blurry, watermark' });
    const res = await reversePrompt('/tmp/local.png');
    expect(res).toEqual({ kind: 'image', prompt: 'a cat sitting on a sofa', negative: 'blurry, watermark' });
    const call = lastUpload();
    expect(call.url).toContain('/api/reverse');
    expect(call.name).toBe('file');
    expect(call.header.Authorization).toBe('Bearer tk');
  });

  it('NSFW 意图开启时注入 X-NSFW 头（JoyCaption 专线触发条件）', async () => {
    setNsfwIntent(true);
    setUploadResult(200, { kind: 'image', prompt: 'x', negative: null });
    await reversePrompt('/tmp/n.png');
    expect(lastUpload().header['X-NSFW']).toBe('1');
  });

  it('SFW 默认不带 X-NSFW 头', async () => {
    setUploadResult(200, { kind: 'image', prompt: 'x', negative: null });
    await reversePrompt('/tmp/s.png');
    expect(lastUpload().header['X-NSFW']).toBeUndefined();
  });

  it('negative 缺省/null 归一化为 null', async () => {
    setUploadResult(200, { kind: 'video', prompt: 'camera push in' });
    const res = await reversePrompt('/tmp/v.mp4');
    expect(res).toEqual({ kind: 'video', prompt: 'camera push in', negative: null });
  });

  it('413 文件过大 → ApiError 带人话', async () => {
    setUploadResult(413, { detail: '文件过大(image 上限 20MB)' });
    await expect(reversePrompt('/tmp/big.png')).rejects.toMatchObject({ status: 413 });
  });

  it('502 VLM 不可达 → ApiError 带人话', async () => {
    setUploadResult(502, { detail: 'VLM 反推服务不可达' });
    await expect(reversePrompt('/tmp/x.png')).rejects.toMatchObject({
      status: 502,
      message: '服务暂时不可用，请稍后重试',
    });
  });
});

// ── MP18：优化提示词（POST /api/optimize，契约已读 apps/api/app/routes/optimize.py）──
describe('optimizePrompt', () => {
  it('POST /api/optimize 带 prompt+kind，返回 optimized/negative', async () => {
    enqueueResponse(200, {
      optimized: 'masterpiece, best quality, a cat sitting on a sofa, soft light',
      negative: 'blurry, watermark, bad anatomy',
    });
    const res = await optimizePrompt({ prompt: '一只猫坐在沙发上', kind: 'image' });
    expect(res).toEqual({
      optimized: 'masterpiece, best quality, a cat sitting on a sofa, soft light',
      negative: 'blurry, watermark, bad anatomy',
    });
    expect(lastRequest().url).toContain('/api/optimize');
    expect(lastRequest().data).toEqual({ prompt: '一只猫坐在沙发上', kind: 'image' });
  });

  it('kind 跟随引擎直通（audio 单段类无 negative → 归一化 null）', async () => {
    enqueueResponse(200, { optimized: 'lofi, chill, piano, warm, 90bpm' });
    const res = await optimizePrompt({ prompt: '放松的音乐', kind: 'audio' });
    expect(res).toEqual({ optimized: 'lofi, chill, piano, warm, 90bpm', negative: null });
    expect(lastRequest().data).toEqual({ prompt: '放松的音乐', kind: 'audio' });
  });

  it('video 类返回 negative（视频引擎吃负向词）', async () => {
    enqueueResponse(200, {
      optimized: 'a cat walking, slow pan, cinematic lighting',
      negative: 'blurry, flickering, morphing',
    });
    const res = await optimizePrompt({ prompt: '猫走路', kind: 'video' });
    expect(res.negative).toBe('blurry, flickering, morphing');
  });

  it('502 优化失败 → ApiError 带人话', async () => {
    enqueueResponse(502, { detail: '优化失败,请重试' });
    await expect(optimizePrompt({ prompt: 'x', kind: 'image' })).rejects.toMatchObject({
      status: 502,
      message: '服务暂时不可用，请稍后重试',
    });
  });

  it('503 LLM 不可达 → ApiError 带人话', async () => {
    enqueueResponse(503, { detail: 'LLM 层全部不可用' });
    await expect(optimizePrompt({ prompt: 'x', kind: 'image' })).rejects.toMatchObject({
      status: 503,
      message: '服务暂时不可用，请稍后重试',
    });
  });
});

describe('uploadVideo', () => {
  it('kind 走 query，字段名仍为 image（后端契约）', async () => {
    setUploadResult(200, { filename: 'v.mp4', worker: 'w1' });
    const res = await uploadVideo('/tmp/v.mp4', 'wan_animate');
    expect(res).toEqual({ filename: 'v.mp4', worker: 'w1' });
    const call = lastUpload();
    expect(call.url).toContain('/api/upload?kind=wan_animate');
    expect(call.name).toBe('image');
  });

  it('pinWorker 钉参考图落点（wan-animate 互钉）', async () => {
    setUploadResult(200, { filename: 'v.mp4', worker: 'w1' });
    await uploadVideo('/tmp/v.mp4', 'wan_animate', 'w1');
    expect(lastUpload().url).toContain('kind=wan_animate&worker=w1');
  });
});

describe('uploadAudio（MP12）', () => {
  it('kind 走 query，字段名仍为 image（后端契约）', async () => {
    setUploadResult(200, { filename: 'a.mp3', worker: 'w1' });
    const res = await uploadAudio('/tmp/a.mp3', 'ltx_lipsync');
    expect(res).toEqual({ filename: 'a.mp3', worker: 'w1' });
    const call = lastUpload();
    expect(call.url).toContain('/api/upload?kind=ltx_lipsync');
    expect(call.name).toBe('image');
  });

  it('pinWorker 钉参考图落点（ltx-nsfw-lipsync 互钉）', async () => {
    setUploadResult(200, { filename: 'a.wav', worker: 'w1' });
    await uploadAudio('/tmp/a.wav', 'ltx_lipsync', 'w1');
    expect(lastUpload().url).toContain('kind=ltx_lipsync&worker=w1');
  });
});

describe('SFW 视频引擎提交', () => {
  it('submitWanAnimate POST /api/wan/animate 带 image/video/worker', async () => {
    enqueueResponse(200, { prompt_id: 'p3', client_id: 'c1', worker: 'w1', seed: 2 });
    await submitWanAnimate({ positive: 'x', image: 'a.png', video: 'v.mp4', worker: 'w1' });
    expect(lastRequest().url).toContain('/api/wan/animate');
    expect(lastRequest().data).toMatchObject({ image: 'a.png', video: 'v.mp4', worker: 'w1' });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitWanVace POST /api/wan/vace 带 images 数组 + worker', async () => {
    enqueueResponse(200, { prompt_id: 'p4', client_id: 'c1', worker: 'w1', seed: 3 });
    await submitWanVace({ positive: 'x', images: ['a.png', 'b.png'], worker: 'w1' });
    expect(lastRequest().url).toContain('/api/wan/vace');
    expect(lastRequest().data).toMatchObject({ images: ['a.png', 'b.png'], worker: 'w1' });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('422 detail 数组展开首条 msg', async () => {
    enqueueResponse(422, {
      detail: [
        { loc: ['body', 'width'], msg: 'Input should be greater than or equal to 256', type: 'greater_than_equal' },
        { loc: ['body', 'fps'], msg: 'second error', type: 'x' },
      ],
    });
    await expect(
      submitWanAnimate({ positive: 'x', image: 'a.png', video: 'v.mp4', worker: 'w1', width: 100 }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Input should be greater than or equal to 256',
    });
  });

  it('非数组 detail 字符串直取', async () => {
    enqueueResponse(400, { detail: 'worker 离线' });
    await expect(submitWanVace({ positive: 'x', images: ['a.png'], worker: 'w1' })).rejects.toMatchObject({
      status: 400,
      message: 'worker 离线',
    });
  });
});

describe('H3 / LongCat / ACE 引擎提交（MP11）', () => {
  it('submitH3T2V POST /api/h3/t2v 带 loras 数组，LONG 超时', async () => {
    enqueueResponse(200, { prompt_id: 'ph1', client_id: 'c1', worker: 'w-h3', seed: 42 });
    const res = await submitH3T2V({
      positive: '海港黄昏',
      loras: [{ name: 'h3_detail.safetensors', strength: 0.7 }],
      length: 124,
    });
    expect(res.prompt_id).toBe('ph1');
    expect(lastRequest().url).toContain('/api/h3/t2v');
    expect(lastRequest().data).toEqual({
      positive: '海港黄昏',
      loras: [{ name: 'h3_detail.safetensors', strength: 0.7 }],
      length: 124,
    });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitH3I2V POST /api/h3/i2v 带 image/worker（kind=h3_i2v 上传落点）', async () => {
    enqueueResponse(200, { prompt_id: 'ph2', client_id: 'c1', worker: 'w1', seed: 1 });
    await submitH3I2V({ positive: 'x', image: 'f.png', worker: 'w1', loras: [] });
    expect(lastRequest().url).toContain('/api/h3/i2v');
    expect(lastRequest().data).toMatchObject({ image: 'f.png', worker: 'w1' });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitLongCatT2V POST /api/longcat/t2v（无 cfg，蒸馏链路固定）', async () => {
    enqueueResponse(200, { prompt_id: 'pl1', client_id: 'c1', worker: 'w-lc', seed: 7 });
    const res = await submitLongCatT2V({ positive: '长镜头', num_frames: 961, fps: 16 });
    expect(res.prompt_id).toBe('pl1');
    expect(lastRequest().url).toContain('/api/longcat/t2v');
    expect(lastRequest().data).toEqual({ positive: '长镜头', num_frames: 961, fps: 16 });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitLongCatI2V POST /api/longcat/i2v 带 image/worker', async () => {
    enqueueResponse(200, { prompt_id: 'pl2', client_id: 'c1', worker: 'w1', seed: 2 });
    await submitLongCatI2V({ positive: 'x', image: 'lc.png', worker: 'w1' });
    expect(lastRequest().url).toContain('/api/longcat/i2v');
    expect(lastRequest().data).toMatchObject({ image: 'lc.png', worker: 'w1' });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitLongCatContinue POST /api/longcat/continue 带 video 产物 URL', async () => {
    enqueueResponse(200, { prompt_id: 'pl3', client_id: 'c1', worker: 'w-lc', seed: 3 });
    await submitLongCatContinue({
      positive: '接着走',
      video: '/api/images?path=outputs/a.mp4',
      num_frames: 121,
    });
    expect(lastRequest().url).toContain('/api/longcat/continue');
    expect(lastRequest().data).toMatchObject({
      positive: '接着走',
      video: '/api/images?path=outputs/a.mp4',
      num_frames: 121,
    });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitAceMusic POST /api/generate/audio 带 tags/seconds', async () => {
    enqueueResponse(200, { prompt_id: 'pa1', client_id: 'c1', worker: 'w1', seed: 5 });
    const res = await submitAceMusic({ tags: 'lo-fi hip hop', seconds: 60, steps: 50, cfg: 5 });
    expect(res.prompt_id).toBe('pa1');
    expect(lastRequest().url).toContain('/api/generate/audio');
    expect(lastRequest().data).toEqual({ tags: 'lo-fi hip hop', seconds: 60, steps: 50, cfg: 5 });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });
});

describe('R18 视频引擎提交（MP12）', () => {
  it('submitLtxNsfwT2V POST /api/generate/ltx-t2v，LONG 超时', async () => {
    enqueueResponse(200, { prompt_id: 'pn1', client_id: 'c1', worker: 'w1', seed: 42 });
    const res = await submitLtxNsfwT2V({
      positive: 'x',
      width: 1280,
      height: 720,
      length: 97,
      fps: 16,
      steps: 20,
      cfg: 1,
      use_upscale: false,
      use_rife: true,
    });
    expect(res.prompt_id).toBe('pn1');
    expect(lastRequest().url).toContain('/api/generate/ltx-t2v');
    expect(lastRequest().data).toMatchObject({ width: 1280, height: 720, length: 97, use_rife: true });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitLtxNsfwI2V POST /api/generate/ltx-i2v 带 image/worker', async () => {
    enqueueResponse(200, { prompt_id: 'pn2', client_id: 'c1', worker: 'w1', seed: 1 });
    await submitLtxNsfwI2V({ positive: 'x', image: 'f.png', worker: 'w1' });
    expect(lastRequest().url).toContain('/api/generate/ltx-i2v');
    expect(lastRequest().data).toMatchObject({ image: 'f.png', worker: 'w1' });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitLtxNsfwLipsync POST /api/generate/ltx-lipsync 带 image/audio/worker/id_lora', async () => {
    enqueueResponse(200, { prompt_id: 'pn3', client_id: 'c1', worker: 'w1', seed: 2 });
    await submitLtxNsfwLipsync({
      positive: 'x',
      image: 'f.png',
      audio: 'a.wav',
      worker: 'w1',
      id_lora: 'id.safetensors',
      id_lora_strength: 0.8,
    });
    expect(lastRequest().url).toContain('/api/generate/ltx-lipsync');
    expect(lastRequest().data).toMatchObject({
      image: 'f.png',
      audio: 'a.wav',
      worker: 'w1',
      id_lora: 'id.safetensors',
      id_lora_strength: 0.8,
    });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('403 门控：主站上下文（无 X-NSFW 头）被拒', async () => {
    enqueueResponse(403, { detail: 'LTX 视频生成仅限 NSFW 专区访问' });
    await expect(submitLtxNsfwT2V({ positive: 'x' })).rejects.toMatchObject({
      status: 403,
      message: '没有权限执行此操作',
    });
  });
});

describe('LongCat-Avatar 数字人提交（MP14）', () => {
  it('submitAvatarTalk POST /api/avatar/talk 带 image/audio/worker，LONG 超时', async () => {
    enqueueResponse(200, { prompt_id: 'pt1', client_id: 'c1', worker: 'w1', seed: 7 });
    const res = await submitAvatarTalk({
      positive: '一位女士面对镜头自然说话',
      image: 'portrait.png',
      audio: 'voice.wav',
      worker: 'w1',
      width: 480,
      height: 832,
      num_frames: 93,
      fps: 25,
      steps: 12,
    });
    expect(res.prompt_id).toBe('pt1');
    expect(lastRequest().url).toContain('/api/avatar/talk');
    expect(lastRequest().data).toEqual({
      positive: '一位女士面对镜头自然说话',
      image: 'portrait.png',
      audio: 'voice.wav',
      worker: 'w1',
      width: 480,
      height: 832,
      num_frames: 93,
      fps: 25,
      steps: 12,
    });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('SFW 引擎：主站上下文（无 X-NSFW 头）直接放行', async () => {
    enqueueResponse(200, { prompt_id: 'pt2', client_id: 'c1', worker: 'w1', seed: 1 });
    await submitAvatarTalk({ positive: 'x', image: 'p.png', audio: 'a.wav', worker: 'w1' });
    expect(lastRequest().header?.['X-NSFW']).toBeUndefined();
  });
});

describe('引擎补齐提交', () => {
  it('submitQwenEdit POST /api/generate/qwen-edit 带 image/worker/camera', async () => {
    enqueueResponse(200, { prompt_id: 'pq', client_id: 'c1', worker: 'w1', seed: 1 });
    await submitQwenEdit({ image: 'f.png', worker: 'w1', positive: '换成红色', camera: 'left', fast: true });
    expect(lastRequest().url).toContain('/api/generate/qwen-edit');
    expect(lastRequest().data).toMatchObject({ image: 'f.png', worker: 'w1', camera: 'left' });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitH3MultiShot POST /api/h3/multishot 带 shots', async () => {
    enqueueResponse(200, { prompt_id: 'pm', client_id: 'c1', worker: 'w-h3', seed: 2 });
    await submitH3MultiShot({
      shots: [{ prompt: '海边' }, { prompt: '城市' }],
      total_duration: 8,
    });
    expect(lastRequest().url).toContain('/api/h3/multishot');
    expect(lastRequest().data).toMatchObject({ total_duration: 8 });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('submitWanTransition POST /api/generate/transition 带 first/last_frame', async () => {
    enqueueResponse(200, { prompt_id: 'pt', client_id: 'c1', worker: 'w1', seed: 3 });
    await submitWanTransition({
      positive: '过渡',
      first_frame: 'a.png',
      last_frame: 'b.png',
      worker: 'w1',
    });
    expect(lastRequest().url).toContain('/api/generate/transition');
    expect(lastRequest().data).toMatchObject({ first_frame: 'a.png', last_frame: 'b.png' });
  });

  it('submitKeyframeChain POST /api/generate/keyframe-chain；缺 client_id 归一为空串', async () => {
    enqueueResponse(200, { prompt_id: 'pk', worker: 'w1', seed: 4, segments: ['s1'] });
    const res = await submitKeyframeChain({
      keyframes: ['a.png', 'b.png'],
      prompts: '转场',
      worker: 'w1',
    });
    expect(lastRequest().url).toContain('/api/generate/keyframe-chain');
    expect(res.prompt_id).toBe('pk');
    expect(res.client_id).toBe('');
  });

  it('submitVaceEdit POST /api/generate/video-edit 带 source_video/edit_prompt', async () => {
    enqueueResponse(200, { prompt_id: 'pe', client_id: 'c1', worker: 'w1', seed: 5 });
    await submitVaceEdit({
      source_video: 'v.mp4',
      edit_prompt: 'watercolor',
      edit_mode: 'style_transfer',
      worker: 'w1',
    });
    expect(lastRequest().url).toContain('/api/generate/video-edit');
    expect(lastRequest().data).toMatchObject({ source_video: 'v.mp4', edit_mode: 'style_transfer' });
  });

  it('submitWanAnimate2 POST /api/wan/animate2 带 image/video', async () => {
    enqueueResponse(200, { prompt_id: 'pa2', client_id: 'c1', worker: 'w1', seed: 6 });
    await submitWanAnimate2({ positive: '', image: 'a.png', video: 'v.mp4', worker: 'w1' });
    expect(lastRequest().url).toContain('/api/wan/animate2');
    expect(lastRequest().data).toMatchObject({ image: 'a.png', video: 'v.mp4' });
  });

  it('submitWanNsfwI2V POST /api/generate/video 带 image/length/loras', async () => {
    enqueueResponse(200, { prompt_id: 'pw', client_id: 'c1', worker: 'w1', seed: 7 });
    await submitWanNsfwI2V({
      positive: 'x',
      image: 'f.png',
      worker: 'w1',
      length: 81,
      loras: [{ name: 'a.safetensors', strength: 0.7 }],
    });
    expect(lastRequest().url).toContain('/api/generate/video');
    expect(lastRequest().data).toMatchObject({ image: 'f.png', length: 81 });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });
});

// ── MP20：文档挂载（/api/docs 系列，契约已读 apps/api/app/routes/documents.py）──
describe('docs（MP20）', () => {
  const doc = {
    id: 'd1',
    filename: '需求文档.pdf',
    kind: 'pdf',
    size: 2048,
    chunk_count: 3,
    status: 'ready',
    created_at: '2026-08-14T00:00:00',
  };

  it('listDocs GET /api/docs → DocItem[] 原样返回', async () => {
    enqueueResponse(200, [doc]);
    const res = await listDocs();
    expect(res).toEqual([doc]);
    expect(lastRequest().url).toContain('/api/docs');
    expect(lastRequest().method).toBe('GET');
  });

  it('uploadDoc multipart 字段名 file（非 image），201 返回 DocItem', async () => {
    setToken('tk');
    setUploadResult(201, doc);
    const res = await uploadDoc('/tmp/需求文档.pdf');
    expect(res).toEqual(doc);
    const call = lastUpload();
    expect(call.url).toContain('/api/docs/upload');
    expect(call.name).toBe('file');
    expect(call.header.Authorization).toBe('Bearer tk');
  });

  it('uploadDoc 400 不支持类型 → ApiError 带后端 detail', async () => {
    setUploadResult(400, { detail: '仅支持 pdf / docx / txt / md 文件' });
    await expect(uploadDoc('/tmp/x.exe')).rejects.toMatchObject({ status: 400 });
  });

  it('deleteDoc DELETE /api/docs/{id}', async () => {
    enqueueResponse(200, { ok: true });
    await deleteDoc('d1');
    expect(lastRequest().method).toBe('DELETE');
    expect(lastRequest().url).toContain('/api/docs/d1');
  });

  it('deleteDoc 404 文档不存在 → ApiError 带人话', async () => {
    enqueueResponse(404, { detail: '文档不存在' });
    await expect(deleteDoc('gone')).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});

describe('jobs', () => {
  it('listJobs 默认 limit=50', async () => {
    enqueueResponse(200, []);
    await listJobs();
    expect(lastRequest().url).toContain('/api/jobs?limit=50');
  });

  it('listJobs 带 status 过滤', async () => {
    enqueueResponse(200, []);
    await listJobs({ limit: 10, status: 'running' });
    expect(lastRequest().url).toContain('limit=10');
    expect(lastRequest().url).toContain('status=running');
  });

  it('listJobs 带 offset 分页（MP15）', async () => {
    enqueueResponse(200, []);
    await listJobs({ limit: 24, offset: 48 });
    expect(lastRequest().url).toContain('limit=24');
    expect(lastRequest().url).toContain('offset=48');
  });

  it('listJobs 默认 / offset=0 不序列化 offset（既有调用方兼容）', async () => {
    enqueueResponse(200, []);
    await listJobs();
    expect(lastRequest().url).not.toContain('offset');
    enqueueResponse(200, []);
    await listJobs({ limit: 24, offset: 0 });
    expect(lastRequest().url).not.toContain('offset');
  });

  it('deleteJob DELETE 方法', async () => {
    enqueueResponse(204, '');
    await deleteJob('j1');
    expect(lastRequest().method).toBe('DELETE');
    expect(lastRequest().url).toContain('/api/jobs/j1');
  });

  it('cancelJob POST /api/jobs/{id}/cancel', async () => {
    enqueueResponse(200, { ok: true, status: 'canceled', worker_action: 'skipped' });
    const res = await cancelJob('j1');
    expect(res.status).toBe('canceled');
    expect(lastRequest().method).toBe('POST');
    expect(lastRequest().url).toContain('/api/jobs/j1/cancel');
  });

  it('rerunJob POST body', async () => {
    enqueueResponse(200, { prompt_id: 'p', client_id: 'c', worker: 'w', seed: 7 });
    await rerunJob('j1', { seed_mode: 'keep' });
    expect(lastRequest().url).toContain('/api/jobs/j1/rerun');
    expect(lastRequest().data).toEqual({ seed_mode: 'keep' });
  });

  it('fetchVersions GET versions 端点', async () => {
    enqueueResponse(200, []);
    await fetchVersions('j1');
    expect(lastRequest().url).toContain('/api/jobs/j1/versions');
  });
});
