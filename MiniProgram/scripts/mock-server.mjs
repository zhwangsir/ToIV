#!/usr/bin/env node
/**
 * ToIV H5 走查用 Mock API（零依赖，仅本机 UX 测试）
 * 端点逐条对齐 src/api/index.ts 契约
 * 用法：node scripts/mock-server.mjs  →  http://localhost:9800
 */
import { createServer } from 'node:http';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const user = { id: 'u1', email: 'ux-walkthrough@toiv.dev', role: 'user' };

const engine = {
  id: 'txt2img',
  label: 'SDXL 文生图',
  kind: 'image',
  available: true,
  nsfw: false,
  description: '基础文生图引擎（mock）',
  params: [
    { key: 'width', label: '宽度', type: 'number', default: 1024, min: 256, max: 2048, step: 64 },
    { key: 'height', label: '高度', type: 'number', default: 1024, min: 256, max: 2048, step: 64 },
    { key: 'steps', label: '步数', type: 'number', default: 28, min: 1, max: 60 },
    { key: 'cfg', label: 'CFG', type: 'number', default: 7, min: 1, max: 20 },
  ],
};

// MP10：SFW 视频引擎（参数 schema 精简但形状与后端注册表一致）
const ltx25T2V = {
  id: 'ltx25-t2v',
  label: 'LTX 2.5 文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  description: 'LTX-2.5 音画同出短视频（mock）',
  params: [
    { key: 'negative', label: '负面提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 960, min: 256, max: 1920, step: 32 },
    { key: 'height', label: '高度', type: 'number', default: 544, min: 256, max: 1088, step: 32 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 5, min: 0.5, max: 60, step: 0.5 },
    { key: 'fps', label: '帧率', type: 'number', default: 24, min: 8, max: 60 },
    { key: 'steps', label: '采样步数', type: 'number', default: 8, min: 1, max: 50 },
    { key: 'seed', label: '种子', type: 'number', default: null },
  ],
};

const ltx25I2V = {
  ...ltx25T2V,
  id: 'ltx25-i2v',
  label: 'LTX 2.5 图生视频',
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...ltx25T2V.params,
    { key: 'strength', label: '首帧强度', type: 'number', default: 0.7, min: 0, max: 1, step: 0.05 },
  ],
};

const wanAnimate = {
  id: 'wan-animate',
  label: 'Wan2.2 动作迁移',
  kind: 'video',
  available: true,
  nsfw: false,
  description: '参考图角色按驱动视频动作表演（mock）',
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    { key: 'video', label: '驱动视频', type: 'video', default: null },
    { key: 'negative', label: '负面提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
    { key: 'height', label: '高度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 7.5, min: 0.5, max: 31, step: 0.5 },
    { key: 'steps', label: '采样步数', type: 'number', default: 6, min: 1, max: 50 },
    { key: 'fps', label: '帧率', type: 'number', default: 16, min: 8, max: 30 },
    { key: 'seed', label: '种子', type: 'number', default: null },
  ],
};

const wanVace = {
  ...wanAnimate,
  id: 'wan-vace',
  label: 'VACE 多参考视频',
  params: [
    { key: 'images', label: '参考图(1-4 张)', type: 'images', max: 4, default: null },
    ...wanAnimate.params.filter((p) => p.key !== 'images' && p.key !== 'video'),
  ],
};

// MP11：H3 引擎（loras 参数形状对齐注册表 _h3_loras_select 注入后：options + min/max/step 强度区间）
const h3Params = [
  { key: 'negative', label: '负面提示词', type: 'textarea', default: '' },
  { key: 'width', label: '宽度', type: 'number', default: 1344, min: 256, max: 1344, step: 32 },
  { key: 'height', label: '高度', type: 'number', default: 768, min: 256, max: 1344, step: 32 },
  { key: 'duration', label: '时长(秒)', type: 'number', default: 5, min: 0.5, max: 60, step: 0.5 },
  { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 50 },
  { key: 'seed', label: '种子', type: 'number', default: null },
  {
    key: 'loras', label: 'LoRA 叠加', type: 'loras', default: [],
    options: [
      { value: 'h3_detail.safetensors', label: 'h3_detail.safetensors' },
      { value: 'h3_motion.safetensors', label: 'h3_motion.safetensors' },
      { value: 'h3_style_ink.safetensors', label: 'h3_style_ink.safetensors' },
      { value: 'h3_r18_demo.safetensors', label: 'h3_r18_demo.safetensors', nsfw: true },
    ],
    min: 0.5, max: 1.0, step: 0.05,
    hint: '可选，最多 3 个；推荐强度 0.5-1.0（默认 0.6）',
  },
];

const h3T2V = {
  id: 'h3-t2v',
  label: 'MiniMax H3 文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  description: 'MiniMax H3 音画同发短视频（mock）',
  params: h3Params,
};

const h3I2V = {
  ...h3T2V,
  id: 'h3-i2v',
  label: 'MiniMax H3 图生视频',
  params: [{ key: 'images', label: '参考图', type: 'images', max: 1, default: null }, ...h3Params],
};

// MP11：LongCat 引擎（参数与 routes/longcat_studio.py 同一套范围；无 cfg）
const longcatParams = [
  { key: 'negative', label: '负面提示词', type: 'textarea', default: '' },
  { key: 'width', label: '宽度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
  { key: 'height', label: '高度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
  { key: 'duration', label: '时长(秒)', type: 'number', default: 7.5, min: 0.5, max: 60, step: 0.5 },
  { key: 'steps', label: '采样步数', type: 'number', default: 10, min: 1, max: 50 },
  { key: 'fps', label: '帧率', type: 'number', default: 16, min: 8, max: 30 },
  { key: 'seed', label: '种子', type: 'number', default: null },
];

const longcatT2V = {
  id: 'longcat-t2v',
  label: 'LongCat 文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  description: 'LongCat 长镜头引擎（mock）',
  params: longcatParams,
};

const longcatI2V = {
  ...longcatT2V,
  id: 'longcat-i2v',
  label: 'LongCat 图生视频',
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...longcatParams,
  ],
};

const longcatContinue = {
  ...longcatT2V,
  id: 'longcat-continue',
  label: 'LongCat 视频续写',
  description: '取已有视频末帧续写下一段长镜头（mock）',
  params: [
    {
      key: 'video', label: '源视频', type: 'text', default: '',
      hint: '/api/images?... 产物 URL（如上一段 LongCat 产物链接）',
    },
    ...longcatParams,
  ],
};

// MP11：ACE-Step 文生音乐（kind=audio；positive 主提示词映射 tags）
const aceMusic = {
  id: 'ace-music',
  label: 'ACE 文生音乐',
  kind: 'audio',
  available: true,
  nsfw: false,
  description: '风格标签 + 歌词 → MP3（mock）',
  params: [
    { key: 'lyrics', label: '歌词', type: 'textarea', default: '', hint: '留空=纯音乐' },
    { key: 'seconds', label: '时长(秒)', type: 'number', default: 30, min: 5, max: 240, step: 1 },
    { key: 'steps', label: '采样步数', type: 'number', default: 50, min: 10, max: 150 },
    { key: 'cfg', label: 'CFG', type: 'number', default: 5, min: 0, max: 20, step: 0.5 },
    { key: 'seed', label: '种子', type: 'number', default: null },
  ],
};

// MP12：R18 视频引擎（nsfw:true；/api/models/engines 按 X-NSFW 头过滤，对齐后端 list_engines）
// 参数形状逐字段对齐 engine_registry.py _ltx_nsfw_video_params()/_h3_nsfw_video_params()
const ltxNsfwVideoParams = [
  { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
  {
    key: 'resolution', label: '分辨率', type: 'select', default: '1280x720',
    options: [
      { value: '864x480', label: '480p 横版 (864×480)' },
      { value: '1280x720', label: '720p 横版 (1280×720)' },
      { value: '1920x1080', label: '1080p 横版 (1920×1080)' },
      { value: '480x864', label: '480p 竖版 (480×864)' },
      { value: '720x1280', label: '720p 竖版 (720×1280)' },
    ],
  },
  {
    key: 'duration', label: '时长', type: 'select', default: '6',
    options: [
      { value: '4', label: '4 秒' },
      { value: '6', label: '6 秒' },
      { value: '8', label: '8 秒' },
      { value: '10', label: '10 秒' },
      { value: '15', label: '15 秒' },
    ],
    hint: '实际帧数按帧率换算并吸附 8k+1 网格,秒差大时生成后精确裁切',
  },
  { key: 'fps', label: '帧率', type: 'number', default: 16, min: 4, max: 30 },
  { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 50 },
  { key: 'cfg', label: 'CFG', type: 'number', default: 1.0, min: 0, max: 20, step: 0.5 },
  { key: 'seed', label: '随机种子', type: 'text', default: '' },
  { key: 'use_upscale', label: '高清放大(2 阶段)', type: 'switch', default: false },
  { key: 'use_rife', label: 'RIFE 补帧', type: 'switch', default: false },
];

const h3NsfwVideoParams = [
  { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
  {
    key: 'resolution', label: '分辨率', type: 'select', default: '1280x736',
    options: [
      { value: '832x480', label: '480p 横版 (832×480)' },
      { value: '1280x736', label: '720p 横版 (1280×736)' },
      { value: '1344x768', label: '768p 横版 (1344×768)' },
      { value: '480x832', label: '480p 竖版 (480×832)' },
      { value: '736x1280', label: '720p 竖版 (736×1280)' },
      { value: '768x1344', label: '768p 竖版 (768×1344)' },
    ],
  },
  {
    key: 'duration', label: '时长', type: 'select', default: '6',
    options: [
      { value: '4', label: '4 秒' },
      { value: '6', label: '6 秒' },
      { value: '8', label: '8 秒' },
      { value: '10', label: '10 秒' },
      { value: '15', label: '15 秒' },
    ],
    hint: 'H3 固定 24fps;非网格时长自动吸附 17k+5 网格后精确裁切',
  },
  { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 50 },
  { key: 'seed', label: '随机种子', type: 'text', default: '' },
  // loras 形状复用 SFW h3Params（注册表运行时注入 options；R18 上下文 R18 LoRA 放行）
  h3Params.find((p) => p.key === 'loras'),
];

const ltxNsfwT2V = {
  id: 'ltx-nsfw-t2v',
  label: 'LTX 2.3 文生视频(R18)',
  kind: 'video',
  available: true,
  nsfw: true,
  description: '10Eros 底模成人向文生视频（mock）',
  params: ltxNsfwVideoParams,
};

const ltxNsfwI2V = {
  ...ltxNsfwT2V,
  id: 'ltx-nsfw-i2v',
  label: 'LTX 2.3 图生视频(R18)',
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...ltxNsfwVideoParams,
  ],
};

const ltxNsfwLipsync = {
  ...ltxNsfwT2V,
  id: 'ltx-nsfw-lipsync',
  label: 'LTX 2.3 对口型(R18)',
  description: '人物参考图 + 驱动音频 → 对口型视频（mock）',
  params: [
    { key: 'images', label: '人物参考图', type: 'images', max: 1, default: null },
    { key: 'audio', label: '驱动音频', type: 'audio', max: 1, default: null },
    ...ltxNsfwVideoParams,
    { key: 'id_lora', label: 'ID LoRA(可选)', type: 'text', default: '' },
    { key: 'id_lora_strength', label: 'ID LoRA 强度', type: 'number', default: 0.8, min: 0, max: 2, step: 0.1 },
  ],
};

const h3NsfwT2V = {
  id: 'h3-nsfw-t2v',
  label: 'MiniMax H3 文生视频(R18)',
  kind: 'video',
  available: true,
  nsfw: true,
  description: 'H3 成人向文生视频，可叠 R18 LoRA（mock）',
  params: h3NsfwVideoParams,
};

const h3NsfwI2V = {
  ...h3NsfwT2V,
  id: 'h3-nsfw-i2v',
  label: 'MiniMax H3 图生视频(R18)',
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...h3NsfwVideoParams,
  ],
};

// MP14：avatar-talk 数字人已接入（参数逐字段对齐 engine_registry.py _avatar_talk_params()）
// 注册表 audio 为 text 占位（Web 走独立 AvatarGenPanel），本端按引擎 id 特判渲染上传字段
const avatarTalk = {
  id: 'avatar-talk',
  label: 'LongCat-Avatar 数字人',
  kind: 'video',
  available: true,
  nsfw: false,
  description: '音频驱动数字人：人像首帧 + 说话音频 → 口型同步视频（mock）',
  params: [
    { key: 'images', label: '人像首帧', type: 'images', max: 1, default: null, hint: 'jpg / png,单张 ≤ 20MB' },
    { key: 'audio', label: '驱动音频', type: 'text', default: '', hint: 'wav / mp3,经 /api/upload 上传(kind=avatar,≤20MB)' },
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
    { key: 'height', label: '高度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 3.7, min: 0.5, max: 100, step: 0.1 },
    { key: 'fps', label: '帧率', type: 'number', default: 25, min: 8, max: 30 },
    { key: 'steps', label: '采样步数', type: 'number', default: 12, min: 1, max: 50 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
  ],
};

const engines = [
  engine, ltx25T2V, ltx25I2V, wanAnimate, wanVace,
  h3T2V, h3I2V, longcatT2V, longcatI2V, longcatContinue, aceMusic,
  ltxNsfwT2V, ltxNsfwI2V, ltxNsfwLipsync, h3NsfwT2V, h3NsfwI2V,
  avatarTalk,
];

const doneJob = {
  id: 'job-done-1',
  prompt_id: 'p-done-1',
  kind: 'txt2img',
  status: 'done',
  prompt: '一只在胶片暗房里的猫，柔光',
  seed: 42,
  created_at: new Date(Date.now() - 3600_000).toISOString(),
  results: ['outputs/a.png'],
  nsfw: false,
  parent_id: '',
  root_id: '',
  has_params: true,
};

// MP9：版本链走查第二版本（versions>1 时详情页渲染横滑条带；H5 走查无版本数断言，安全）
const doneJobV2 = {
  ...doneJob,
  id: 'job-done-2',
  prompt_id: 'p-done-2',
  seed: 43,
  prompt: '一只在胶片暗房里的猫，柔光（第二版）',
  created_at: new Date(Date.now() - 7200_000).toISOString(),
};

const runningJob = {
  ...doneJob,
  id: 'job-running-1',
  prompt_id: 'p-running-1',
  status: 'running',
  prompt: '雾中山谷，长曝光',
  created_at: new Date().toISOString(),
  results: [],
};

/** 轮询演示：前 N 次返回 running，之后转为 done（验证活跃轮询→终态停） */
let jobsCalls = 0;

// MP29：作业进度 SSE 内存态（/__reset 复位；/__seed sseJobs 种子）
// 剧本：success=progress→done；warning=progress 中段插 quality_warning 再 done；error=progress 中段 error
let sseJobs = [];

// MP19：对话助手内存态（会话 + 消息；/__reset 复位）
let agentSessions = [];
let agentSeq = 0;

// MP21：Agent 团队运行内存态（/__reset 复位）
let agentRuns = [];
let agentRunSeq = 0;

// MP15：作品库分页数据集（52 件 done 作品 = 24+24+4 三页，图像/视频/音频混合，验证无限滚动/去重/过滤填补）
// 分布：i%9===8 → ace_audio（5 件）；i%5===4 → wan_t2v（9 件）；其余 txt2img（38 件含 doneJob）
function makeLibraryJob(i) {
  const kind = i % 9 === 8 ? 'ace_audio' : i % 5 === 4 ? 'wan_t2v' : 'txt2img';
  const ext = kind === 'wan_t2v' ? 'mp4' : kind === 'ace_audio' ? 'mp3' : 'png';
  return {
    ...doneJob,
    id: `lib-job-${i}`,
    prompt_id: `p-lib-${i}`,
    kind,
    prompt: `作品库分页样例 ${i}`,
    created_at: new Date(Date.now() - (i + 2) * 3600_000).toISOString(),
    results: [`outputs/lib-${i}.${ext}`],
  };
}
// MP25：libraryJobs 可变（DELETE 真删内存）+ 工厂复位（/__reset 恢复默认 52 件）
function defaultLibraryJobs() {
  return [doneJob, ...Array.from({ length: 51 }, (_, i) => makeLibraryJob(i))];
}
let libraryJobs = defaultLibraryJobs();
let libSeedSeq = 0;

// MP13：参考资产库内存态（/__reset 一并清空，防用例间状态污染）
let assets = [];
let assetSeq = 0;

// MP20：文档挂载内存态（/__reset 一并清空；created_at 倒序由 unshift 保证）
let docs = [];
let docSeq = 0;

// MP30：最近一次 /api/agent/chat 请求体（走查断言 image/document_ids 上行；/__reset 复位）
let lastChatBody = null;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-NSFW,Accept');
}

function json(res, code, body) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:9800');
  const path = url.pathname;
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === '/__reset') {
    jobsCalls = 0;
    libraryJobs = defaultLibraryJobs();
    libSeedSeq = 0;
    assets = [];
    assetSeq = 0;
    agentSessions = [];
    agentSeq = 0;
    agentRuns = [];
    agentRunSeq = 0;
    docs = [];
    docSeq = 0;
    sseJobs = [];
    lastChatBody = null;
    return json(res, 200, { ok: true });
  }

  // MP30：走查调试端点——GET /__lastChatBody 返回最近一次 /api/agent/chat 请求体（无则 null）
  if (path === '/__lastChatBody' && req.method === 'GET') {
    return json(res, 200, lastChatBody);
  }
  // MP21：走查种子——POST /__seed {agentRuns:[{goal,status,level?,scenario?,plan?,history?}]}
  // 三场景约定：success=SSE 接力到 done；gate=回放 confirm_required 挂确认门；pending=仅排队无新帧
  if (path === '/__seed' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const specs = Array.isArray(parsed.agentRuns) ? parsed.agentRuns : [];
      const now = Date.now();
      const seeded = [];
      for (const spec of specs) {
        const plan = Array.isArray(spec.plan)
          ? spec.plan
          : [
              { id: 't1', kind: 'script', title: '剧本撰写', depends_on: [], status: 'pending', attempt: 0, input: { prompt: '雨夜侦探短片剧本' }, output: {}, verdict: {}, gpu_hint: '' },
              { id: 't2', kind: 'image', title: '概念图生成', depends_on: ['t1'], status: 'pending', attempt: 0, input: { prompt: '雨夜胶片店门口，侦探剪影' }, output: {}, verdict: {}, gpu_hint: '' },
              { id: 't3', kind: 'video', title: '镜头合成', depends_on: ['t2'], status: 'pending', attempt: 0, input: { prompt: '3 秒推轨镜头' }, output: {}, verdict: {}, gpu_hint: '' },
            ];
        const run = {
          id: `run-${++agentRunSeq}`,
          goal: spec.goal ?? '未命名任务',
          level: spec.level ?? 'L2',
          status: spec.status ?? 'running',
          error: spec.error ?? '',
          plan,
          created_at: new Date(now - 600_000).toISOString(),
          updated_at: new Date(now - 60_000).toISOString(),
          scenario: spec.scenario ?? 'pending',
          history: Array.isArray(spec.history) ? spec.history : [],
        };
        agentRuns.push(run);
        seeded.push({ id: run.id });
      }
      // MP24：agentSessions 种子 [{title?,nsfw?,messages:[{role,content?,media?}]}]（消息 id 从 1 起升序，对齐 chat 落库编号）
      const sessionSpecs = Array.isArray(parsed.agentSessions) ? parsed.agentSessions : [];
      const seededSessions = [];
      for (const spec of sessionSpecs) {
        const msgs = Array.isArray(spec.messages) ? spec.messages : [];
        const session = {
          id: `sess-${++agentSeq}`,
          title: spec.title ?? '种子会话',
          nsfw: spec.nsfw === true,
          created_at: new Date(now - 3_600_000).toISOString(),
          updated_at: new Date(now - 60_000).toISOString(),
          message_count: msgs.length,
          messages: msgs.map((m, i) => ({
            id: i + 1,
            role: m.role ?? 'user',
            content: m.content ?? '',
            tool_calls: m.tool_calls ?? null,
            media: Array.isArray(m.media) ? m.media : [],
            created_at: new Date(now - 3_600_000 + i * 1000).toISOString(),
          })),
        };
        agentSessions.push(session);
        seededSessions.push({ id: session.id });
      }
      // MP25：作品库种子 [{id?,kind?,status?,prompt?,results?}]——unshift 置顶（走查首屏即可见）；
      // id 含 'fail' 时 DELETE 注入 500（magic id，覆盖批量删除部分失败分支）
      const jobSpecs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      const seededJobs = [];
      for (const spec of jobSpecs) {
        const kind = spec.kind ?? 'txt2img';
        const ext = kind === 'wan_t2v' ? 'mp4' : kind === 'ace_audio' ? 'mp3' : 'png';
        const seq = ++libSeedSeq;
        const job = {
          ...doneJob,
          id: spec.id ?? `seed-job-${seq}`,
          prompt_id: spec.prompt_id ?? `p-seed-${seq}`,
          kind,
          status: spec.status ?? 'done',
          prompt: spec.prompt ?? '走查种子作品',
          created_at: spec.created_at ?? new Date().toISOString(),
          results: Array.isArray(spec.results) ? spec.results : [`outputs/seed-${seq}.${ext}`],
          nsfw: spec.nsfw === true,
        };
        libraryJobs.unshift(job);
        seededJobs.push({ id: job.id });
      }
      // MP27：资产库种子 [{id?,kind?,name?,description?,images?,nsfw?}]（走查批量管理首屏 ≥3 件可见；
      // DELETE /api/assets/:id MP13 已真删内存，列表减项可断言）
      const assetSpecs = Array.isArray(parsed.assets) ? parsed.assets : [];
      const seededAssets = [];
      for (const spec of assetSpecs) {
        const assetNow = new Date().toISOString();
        const asset = {
          id: spec.id ?? `asset-${++assetSeq}`,
          kind: spec.kind ?? 'character',
          name: spec.name ?? '走查种子资产',
          description: spec.description ?? '',
          images: Array.isArray(spec.images) ? spec.images : [{ filename: 'seed.png', worker: 'w1' }],
          nsfw: Boolean(spec.nsfw),
          created_at: assetNow,
          updated_at: assetNow,
        };
        assets.push(asset);
        seededAssets.push({ id: asset.id });
      }
      // MP29：作业 SSE 剧本种子 [{prompt_id,scenario?}]——prompt_id 需与会话内提交响应回包对齐
      // （txt2img 固定 p-new-1）；scenario: success(默认)/warning/error，帧剧本见 /api/jobs/:id/events
      const sseSpecs = Array.isArray(parsed.sseJobs) ? parsed.sseJobs : [];
      for (const spec of sseSpecs) {
        if (!spec || typeof spec.prompt_id !== 'string' || spec.prompt_id === '') continue;
        sseJobs.push({ prompt_id: spec.prompt_id, scenario: spec.scenario ?? 'success' });
      }
      json(res, 200, { ok: true, runs: seeded, sessions: seededSessions, jobs: seededJobs, assets: seededAssets, sseJobs: sseSpecs.length });
    });
    return;
  }
  if (path === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.email && parsed.password) {
        json(res, 200, { token: 'mock-token-ux', user });
      } else {
        json(res, 400, { detail: '邮箱或密码缺失' });
      }
    });
    return;
  }
  if (path === '/api/auth/me') return json(res, 200, { user, usage: {} });
  // MP12：对齐后端 list_engines —— R18 引擎仅 X-NSFW 上下文可见（前端无门控，纯后端过滤）
  if (path === '/api/models/engines') {
    const allowNsfw = req.headers['x-nsfw'] === '1';
    const visible = engines.filter((e) => allowNsfw || !e.nsfw);
    return json(res, 200, { engines: visible, count: visible.length });
  }
  if (path === '/api/generate/txt2img' && req.method === 'POST') {
    return json(res, 200, { prompt_id: 'p-new-1', client_id: 'c1', worker: 'w1', seed: 42 });
  }
  // MP10：SFW 视频引擎提交端点（GenerateResponse 形状）
  if (
    ['/api/ltx25/t2v', '/api/ltx25/i2v', '/api/wan/animate', '/api/wan/vace'].includes(path) &&
    req.method === 'POST'
  ) {
    return json(res, 200, { prompt_id: 'p-video-1', client_id: 'c1', worker: 'w1', seed: 42 });
  }
  // MP11：H3 / LongCat / ACE 提交端点（GenerateResponse 形状）
  if (
    [
      '/api/h3/t2v',
      '/api/h3/i2v',
      '/api/longcat/t2v',
      '/api/longcat/i2v',
      '/api/longcat/continue',
      '/api/generate/audio',
    ].includes(path) &&
    req.method === 'POST'
  ) {
    return json(res, 200, { prompt_id: 'p-mp11-1', client_id: 'c1', worker: 'w1', seed: 42 });
  }
  // MP12：R18 LTX 提交端点（GenerateResponse 形状；h3-nsfw 复用上方 /api/h3/* 链路）
  if (
    ['/api/generate/ltx-t2v', '/api/generate/ltx-i2v', '/api/generate/ltx-lipsync'].includes(path) &&
    req.method === 'POST'
  ) {
    return json(res, 200, { prompt_id: 'p-r18-1', client_id: 'c1', worker: 'w1', seed: 42 });
  }
  // MP14：LongCat-Avatar 数字人提交端点（GenerateResponse 形状；SFW 引擎主站上下文可见）
  if (path === '/api/avatar/talk' && req.method === 'POST') {
    return json(res, 200, { prompt_id: 'p-avatar-1', client_id: 'c1', worker: 'w1', seed: 42 });
  }
  // MP10：上传（图/视频/音频同字段名 image；worker 互钉透传回显）
  // MP12：从 multipart 头回显真实文件名（kind=ltx_lipsync 图/音互钉需区分句柄）
  if (path === '/api/upload' && req.method === 'POST') {
    const pin = url.searchParams.get('worker');
    let head = '';
    req.on('data', (c) => {
      if (head.length < 8192) head += c.toString('binary'); // 文件名在首部分隔头内，只留前缀
    });
    req.on('end', () => {
      const m = /filename="([^"]+)"/.exec(head);
      json(res, 200, { filename: m ? m[1] : 'mock-upload.bin', worker: pin ?? 'w1' });
    });
    return;
  }
  // MP17：反推提示词（契约对齐 apps/api/app/routes/reverse.py）
  // multipart 字段名 file（非 image）；kind 按 content-type 前缀/扩展名判定；
  // negative 仅图像返回；X-NSFW=1 时图像走 JoyCaption 专线（mock 以措辞区分体现）
  if (path === '/api/reverse' && req.method === 'POST') {
    let head = '';
    req.on('data', (c) => {
      if (head.length < 8192) head += c.toString('binary');
    });
    req.on('end', () => {
      const name = /filename="([^"]+)"/.exec(head)?.[1] ?? 'reverse.bin';
      const ctype = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? '';
      const ext = (name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
      const kind = ctype.startsWith('image/')
        ? 'image'
        : ctype.startsWith('video/')
          ? 'video'
          : ctype.startsWith('audio/')
            ? 'audio'
            : ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)
              ? 'image'
              : ['.mp4', '.mov', '.webm', '.mkv'].includes(ext)
                ? 'video'
                : ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac'].includes(ext)
                  ? 'audio'
                  : null;
      if (!kind) {
        json(res, 400, { detail: '不支持的文件类型(仅图片/视频/音频)' });
        return;
      }
      if (kind === 'image') {
        json(res, 200, {
          kind,
          prompt:
            'a cat sitting on a wooden table in a film darkroom, soft warm light, shallow depth of field, 35mm film photograph',
          negative: 'blurry, watermark, deformed, cartoon',
        });
      } else if (kind === 'video') {
        // 视频反推无 negative（reverse.py: 仅图像系统提示要求负向词）
        json(res, 200, {
          kind,
          prompt:
            'camera slowly pushes in on a cat walking across a darkroom, warm tungsten lighting, cinematic, 35mm film grain',
          negative: null,
        });
      } else {
        json(res, 200, { kind, prompt: '人声：你好（情绪 平静；语种 zh）', negative: null });
      }
    });
    return;
  }
  // MP18：优化提示词（契约对齐 apps/api/app/routes/optimize.py）
  // JSON 入参 { prompt, kind }；negative 仅 image/image_edit/video 类返回，audio 单段类为 null
  if (path === '/api/optimize' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const kind = parsed.kind ?? 'image';
      const text = String(parsed.prompt ?? '');
      if (!text.trim()) {
        json(res, 422, { detail: 'prompt 不能为空' });
        return;
      }
      if (kind === 'audio') {
        // 音频单段类无 negative（optimize.py: 仅 image/image_edit/video 系统提示要求负向词）
        json(res, 200, {
          optimized: `lofi, chill, warm analog piano, vinyl crackle, 85bpm (${text})`,
          negative: null,
        });
      } else if (kind === 'video') {
        json(res, 200, {
          optimized: `${text}, slow cinematic camera push in, warm tungsten lighting, 35mm film grain, shallow depth of field`,
          negative: 'blurry, flickering, morphing, watermark',
        });
      } else {
        json(res, 200, {
          optimized: `masterpiece, best quality, ${text}, soft warm light, film photography, 35mm`,
          negative: 'blurry, watermark, deformed, bad anatomy',
        });
      }
    });
    return;
  }
  // MP20：文档挂载（契约对齐 apps/api/app/routes/documents.py / services/docs.py）
  // 上传 multipart 字段名 file；pdf/docx/txt/md 白名单 400 兜底；列表新→旧（unshift 保证）
  if (path === '/api/docs' && req.method === 'GET') {
    return json(res, 200, docs);
  }
  if (path === '/api/docs/upload' && req.method === 'POST') {
    let head = '';
    req.on('data', (c) => {
      if (head.length < 8192) head += c.toString('binary'); // 文件名在首部分隔头内，只留前缀
    });
    req.on('end', () => {
      // multipart 头按 binary 攒字节，中文文件名需转回 UTF-8 解码（对齐 FastAPI UploadFile 行为）
      const rawName = /filename="([^"]+)"/.exec(head)?.[1] ?? 'mock-doc.txt';
      const name = Buffer.from(rawName, 'binary').toString('utf8');
      const ext = (name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
      if (!['pdf', 'docx', 'txt', 'md'].includes(ext)) {
        json(res, 400, { detail: '仅支持 pdf / docx / txt / md 文件' });
        return;
      }
      const doc = {
        id: `doc-${++docSeq}`,
        filename: name,
        kind: ext,
        size: Number(req.headers['content-length'] ?? 0),
        chunk_count: 4,
        status: 'ready',
        created_at: new Date().toISOString(),
      };
      docs.unshift(doc);
      json(res, 201, doc);
    });
    return;
  }
  const docMatch = path.match(/^\/api\/docs\/([^/]+)$/);
  if (docMatch && req.method === 'DELETE') {
    const doc = docs.find((d) => d.id === docMatch[1]);
    if (!doc) return json(res, 404, { detail: '文档不存在' });
    docs = docs.filter((d) => d.id !== doc.id);
    return json(res, 200, { ok: true });
  }
  // MP19：对话助手（契约对齐 apps/api/app/routes/agent.py / agent/runner.py）
  // SSE 帧：event: msg\ndata: {AgentEvent JSON}，结束 event: done\ndata: {}
  // 会话 id 经 X-Agent-Session-Id 响应头返回；消息逐条落库（user/assistant/tool 媒体）
  if (path === '/api/agent/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      lastChatBody = parsed; // MP30：记录最近一次 chat 请求体（走查 /__lastChatBody 断言上行字段）
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const now = new Date().toISOString();
      let session = parsed.session_id
        ? agentSessions.find((ss) => ss.id === parsed.session_id)
        : null;
      if (!session) {
        session = {
          id: `sess-${++agentSeq}`,
          title: lastUser.slice(0, 18) || '新会话',
          nsfw: false,
          created_at: now,
          updated_at: now,
          message_count: 0,
          messages: [],
        };
        agentSessions.push(session);
      }
      const baseId = session.messages.length;
      // MP20：document_ids 上行回显（走查断言挂载随消息到达后端）
      const docIds = Array.isArray(parsed.document_ids) ? parsed.document_ids : [];
      const docNames = docIds
        .map((id) => docs.find((d) => d.id === id)?.filename)
        .filter(Boolean);
      const docHint =
        docNames.length > 0 ? `已挂载 ${docNames.length} 份文档：${docNames.join('、')}。` : '';
      const replyText = `已按你的想法生成了一张图：「${lastUser.slice(0, 24)}」。${docHint}如需调整风格或比例，直接告诉我。`;
      session.messages.push(
        { id: baseId + 1, role: 'user', content: lastUser, tool_calls: null, media: [], created_at: now },
        { id: baseId + 2, role: 'assistant', content: `收到，我来为你生成。${replyText}`, tool_calls: null, media: [], created_at: now },
        {
          id: baseId + 3,
          role: 'tool',
          content: '{}',
          tool_calls: null,
          media: [{ type: 'image', urls: ['/outputs/mock-agent-1.png'] }],
          created_at: now,
        },
      );
      session.message_count = session.messages.length;
      session.updated_at = now;

      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Agent-Session-Id': session.id,
        // H5 fetch 跨域读自定义响应头必须显式暴露（微信原生无此限制）
        'Access-Control-Expose-Headers': 'X-Agent-Session-Id',
      });
      const frames = [
        `event: msg\ndata: ${JSON.stringify({ type: 'text', content: '收到，我来为你生成。' })}\n\n`,
        `event: msg\ndata: ${JSON.stringify({ type: 'tool', name: 'generate_image' })}\n\n`,
        `event: msg\ndata: ${JSON.stringify({ type: 'image', urls: ['/outputs/mock-agent-1.png'], worker: 'w1' })}\n\n`,
        `event: msg\ndata: ${JSON.stringify({ type: 'text', content: replyText })}\n\n`,
        'event: done\ndata: {}\n\n',
      ];
      let i = 0;
      const tick = () => {
        if (res.destroyed) return; // 前端 abort：停止推送
        if (i >= frames.length) {
          res.end();
          return;
        }
        res.write(frames[i]);
        i += 1;
        setTimeout(tick, 150); // 分帧间隔，验证流式增量渲染
      };
      tick();
    });
    return;
  }
  if (path === '/api/agent/sessions' && req.method === 'GET') {
    const list = [...agentSessions]
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .map(({ messages, ...summary }) => {
        void messages;
        return summary;
      });
    return json(res, 200, list);
  }
  const agentMatch = path.match(/^\/api\/agent\/sessions\/([^/]+)$/);
  if (agentMatch) {
    const session = agentSessions.find((ss) => ss.id === agentMatch[1]);
    if (!session) return json(res, 404, { detail: '会话不存在' });
    if (req.method === 'GET') return json(res, 200, session);
    if (req.method === 'DELETE') {
      agentSessions = agentSessions.filter((ss) => ss.id !== session.id);
      return json(res, 200, { ok: true, id: session.id });
    }
  }
  // MP24：分叉会话（对齐后端 fork_agent_session）——空 body 全量复制；
  // {at_message_id} 截断到该消息（含，id <= at），id 不在源会话 → 404「消息不存在」；
  // 新会话继承 title/nsfw，消息重排 id 从 1 起（与 chat 落库编号一致），返回会话摘要
  const agentForkMatch = path.match(/^\/api\/agent\/sessions\/([^/]+)\/fork$/);
  if (agentForkMatch && req.method === 'POST') {
    const src = agentSessions.find((ss) => ss.id === agentForkMatch[1]);
    if (!src) return json(res, 404, { detail: '会话不存在' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const at = typeof parsed.at_message_id === 'number' ? parsed.at_message_id : null;
      let rows = src.messages;
      if (at !== null) {
        if (!src.messages.some((m) => m.id === at)) {
          return json(res, 404, { detail: '消息不存在' });
        }
        rows = src.messages.filter((m) => m.id <= at);
      }
      const now = new Date().toISOString();
      const fork = {
        id: `sess-${++agentSeq}`,
        title: src.title,
        nsfw: src.nsfw,
        created_at: now,
        updated_at: now,
        message_count: rows.length,
        messages: rows.map((m, i) => ({ ...m, id: i + 1 })),
      };
      agentSessions.push(fork);
      const { messages, ...summary } = fork;
      void messages;
      return json(res, 200, summary);
    });
    return;
  }
  // MP21：Agent 团队监控（列表/详情/SSE 事件流/取消；内存态 /__reset 复位）
  if (path === '/api/agent-runs' && req.method === 'GET') {
    const status = url.searchParams.get('status') ?? '';
    const list = [...agentRuns]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .filter((r) => !status || r.status === status)
      .map((r) => ({
        id: r.id,
        level: r.level,
        goal: r.goal,
        status: r.status,
        created_at: r.created_at,
        task_counts: {
          total: r.plan.length,
          // approved 计入 done（对齐后端 list_agent_runs）
          done: r.plan.filter((t) => t.status === 'done' || t.status === 'approved').length,
          error: r.plan.filter((t) => t.status === 'error').length,
        },
      }));
    return json(res, 200, list);
  }
  const agentRunMatch = path.match(/^\/api\/agent-runs\/([^/]+)(\/events|\/cancel)?$/);
  if (agentRunMatch) {
    const run = agentRuns.find((r) => r.id === agentRunMatch[1]);
    if (!run) return json(res, 404, { detail: '运行不存在或已被清理' });
    const sub = agentRunMatch[2] ?? '';
    if (sub === '' && req.method === 'GET') {
      return json(res, 200, {
        id: run.id,
        goal: run.goal,
        level: run.level,
        status: run.status,
        error: run.error,
        plan: run.plan,
        created_at: run.created_at,
        updated_at: run.updated_at,
      });
    }
    if (sub === '/cancel' && req.method === 'POST') {
      // 409 白名单对齐后端 cancel_run：仅规划/确认门/执行中可取消
      const cancellable = ['planning', 'awaiting_confirm', 'running', 'awaiting_assembly'];
      if (!cancellable.includes(run.status)) {
        return json(res, 409, { detail: `当前状态(${run.status})不可取消` });
      }
      run.status = 'canceled';
      run.updated_at = new Date().toISOString();
      return json(res, 200, { run_id: run.id, status: 'canceled' });
    }
    if (sub === '/events' && req.method === 'GET') {
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // MP9 微信轮：回放过滤——run 已过确认门（resume 裁决后 status 非 awaiting_*）时剔除已被消费的
      // confirm_required 帧；否则前端 onSseEvent 会把徽章打回待确认（与 mock 自身状态机矛盾，
      // H5 因 waitForSelector 能捕到 transient 未暴露，mp IPC 采样延迟下 100% 复现）
      const frames = run.history.filter(
        (f) => !(f && f.event === 'confirm_required' && !String(run.status).startsWith('awaiting_')),
      );
      if (run.scenario === 'success') {
        // 成功剧本：三任务接力推进 → done（分帧验证增量渲染与状态徽章跃迁）
        frames.push(
          { event: 'task_status', data: { task_id: 't1', status: 'running', title: run.plan[0].title } },
          { event: 'task_status', data: { task_id: 't1', status: 'done', title: run.plan[0].title, output: { text: '剧本成稿：雨夜，侦探在胶片店门口点了一支烟。' } } },
          { event: 'task_status', data: { task_id: 't2', status: 'running', title: run.plan[1].title } },
          { event: 'task_status', data: { task_id: 't2', status: 'done', title: run.plan[1].title, output: { image_url: '/outputs/mock-agent-1.png' } } },
          { event: 'task_status', data: { task_id: 't3', status: 'running', title: run.plan[2].title } },
          { event: 'task_status', data: { task_id: 't3', status: 'done', title: run.plan[2].title, output: { video_url: '/outputs/lib-4.mp4' } } },
          { event: 'done', data: { run_id: run.id, final_url: '/outputs/lib-4.mp4' } },
        );
      }
      // gate/pending 场景：history 回放后无新帧，连接保持（前端 abort 断开）
      let i = 0;
      const tick = () => {
        if (res.destroyed) return;
        if (i >= frames.length) {
          // 成功场景推进内存态到终态（之后 GET 详情/列表一致 done）
          if (run.scenario === 'success') {
            run.status = 'done';
            run.updated_at = new Date().toISOString();
            for (const t of run.plan) t.status = 'done';
            run.plan[0].output = { text: '剧本成稿：雨夜，侦探在胶片店门口点了一支烟。' };
            run.plan[1].output = { image_url: '/outputs/mock-agent-1.png' };
            run.plan[2].output = { video_url: '/outputs/lib-4.mp4' };
          }
          res.end();
          return;
        }
        const f = frames[i];
        res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
        i += 1;
        setTimeout(tick, 120);
      };
      tick();
      return;
    }
  }
  // MP23：计划编辑（对齐后端 edit_plan：仅 awaiting_confirm 可改 409；
  // update 按键合并 input / remove 删卡并清理 depends_on 悬挂引用 / add 从 input 提 kind·depends_on；
  // 返回 {run_id, plan:{tasks:简报}}，简报五字段对齐 _task_brief）
  const agentRunPlanMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/plan$/);
  if (agentRunPlanMatch && req.method === 'POST') {
    const run = agentRuns.find((r) => r.id === agentRunPlanMatch[1]);
    if (!run) return json(res, 404, { detail: '运行不存在或已被清理' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (run.status !== 'awaiting_confirm') {
        return json(res, 409, { detail: '仅待确认状态可编辑计划' });
      }
      const ops = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      for (const op of ops) {
        if (op.action === 'add') {
          const inp = { ...(op.input || {}) };
          const kind = inp.kind ?? 'video';
          delete inp.kind;
          const deps = Array.isArray(inp.depends_on) ? inp.depends_on : [];
          delete inp.depends_on;
          run.plan.push({
            id: op.id || `t-${Date.now()}`,
            kind,
            title: op.title || '新任务',
            depends_on: deps,
            status: 'pending',
            attempt: 0,
            input: inp,
            output: {},
            verdict: {},
            gpu_hint: '',
          });
          continue;
        }
        const task = run.plan.find((t) => t.id === op.id);
        if (!task) return json(res, 404, { detail: `任务不存在:${op.id}` });
        if (op.action === 'remove') {
          run.plan = run.plan.filter((t) => t.id !== op.id);
        } else {
          if (op.title !== null && op.title !== undefined) task.title = op.title;
          if (op.input && typeof op.input === 'object') {
            task.input = { ...(task.input || {}), ...op.input };
          }
        }
      }
      const removed = new Set(ops.filter((o) => o.action === 'remove').map((o) => o.id));
      if (removed.size > 0) {
        for (const t of run.plan) {
          t.depends_on = (t.depends_on || []).filter((d) => !removed.has(d));
        }
      }
      run.updated_at = new Date().toISOString();
      json(res, 200, {
        run_id: run.id,
        plan: {
          tasks: run.plan.map((t) => ({
            id: t.id,
            kind: t.kind,
            title: t.title,
            depends_on: t.depends_on,
            status: t.status,
          })),
        },
      });
    });
    return;
  }
  // MP23：成片结果（对齐后端 run_result：done 外 409「任务尚未完成」；
  // final_url 取 assemble done 卡 output.url；duration_sec 合计 video/image 卡 input.duration_sec）
  const agentRunResultMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/result$/);
  if (agentRunResultMatch && req.method === 'GET') {
    const run = agentRuns.find((r) => r.id === agentRunResultMatch[1]);
    if (!run) return json(res, 404, { detail: '运行不存在或已被清理' });
    if (run.status !== 'done') return json(res, 409, { detail: '任务尚未完成' });
    let finalUrl = '';
    for (const t of run.plan) {
      if (t.kind === 'assemble' && t.status === 'done') {
        finalUrl = String((t.output && t.output.url) || '');
      }
    }
    const duration = run.plan
      .filter((t) => t.kind === 'video' || t.kind === 'image')
      .reduce((sum, t) => sum + (Number(t.input && t.input.duration_sec) || 0), 0);
    return json(res, 200, {
      final_url: finalUrl,
      duration_sec: duration,
      tasks: run.plan.map((t) => ({
        id: t.id,
        title: t.title,
        kind: t.kind,
        status: t.status,
        output: t.output || {},
      })),
    });
  }
  // MP22：确认门裁决 resume（对齐后端 resume_run：plan 门需 awaiting_confirm/planning，assembly 门需 awaiting_assembly；
  // plan approve→running / reject→planning+error 记 feedback；assembly approve/reject→running；modify 仅记录不变态）
  const agentRunResumeMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/resume$/);
  if (agentRunResumeMatch && req.method === 'POST') {
    const run = agentRuns.find((r) => r.id === agentRunResumeMatch[1]);
    if (!run) return json(res, 404, { detail: '运行不存在或已被清理' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const gate = parsed.gate;
      const action = parsed.action;
      if (gate === 'plan') {
        if (!['awaiting_confirm', 'planning'].includes(run.status)) {
          return json(res, 409, { detail: `当前状态(${run.status})不可操作计划确认门` });
        }
        if (action === 'approve') {
          run.status = 'running';
          run.error = '';
        } else if (action === 'reject') {
          run.status = 'planning';
          run.error = parsed.feedback || '计划被拒绝';
        }
      } else {
        if (run.status !== 'awaiting_assembly') {
          return json(res, 409, { detail: `当前状态(${run.status})不可操作合成确认门` });
        }
        if (action === 'approve' || action === 'reject') run.status = 'running';
      }
      run.updated_at = new Date().toISOString();
      json(res, 200, { run_id: run.id, status: run.status });
    });
    return;
  }
  // MP33：卡片产物直传替换 multipart（对齐后端 task_upload：合成卡 400；不解析文件体，
  // 置 output={url,source:"upload"} 回 done 直返卡；体必须消费完否则连接悬挂）
  const agentTaskUploadMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/tasks\/([^/]+)\/upload$/);
  if (agentTaskUploadMatch && req.method === 'POST') {
    const run = agentRuns.find((r) => r.id === agentTaskUploadMatch[1]);
    if (!run) return json(res, 404, { detail: '运行不存在或已被清理' });
    const task = run.plan.find((t) => t.id === agentTaskUploadMatch[2]);
    if (!task) return json(res, 404, { detail: '任务卡片不存在' });
    if (task.kind === 'assemble') return json(res, 400, { detail: '合成任务请走合成确认门' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      Buffer.concat(chunks); // 消费 multipart 体（mock 不落盘）
      const output = { url: '/api/studio/files/mock-upload.mp4', source: 'upload' };
      if (task.input && task.input.shot_id) output.shot_id = task.input.shot_id;
      task.output = output;
      task.status = 'done';
      run.updated_at = new Date().toISOString();
      json(res, 200, task);
    });
    return;
  }
  // MP22：卡片干预 task action（对齐后端 task_action：approve→approved 直返卡；edit 合并 payload.input 回 pending；
  // regenerate 仅 done/error（余 409），assemble 卡 400 走合成门，引导词拼进主文案 prompt/dialogue，run 按需回 running）
  const agentTaskActionMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/tasks\/([^/]+)\/action$/);
  if (agentTaskActionMatch && req.method === 'POST') {
    const run = agentRuns.find((r) => r.id === agentTaskActionMatch[1]);
    if (!run) return json(res, 404, { detail: '运行不存在或已被清理' });
    const task = run.plan.find((t) => t.id === agentTaskActionMatch[2]);
    if (!task) return json(res, 404, { detail: '任务卡片不存在' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const action = parsed.action;
      if (action === 'approve') {
        task.status = 'approved';
      } else if (action === 'edit') {
        const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
        const patch = payload.input && typeof payload.input === 'object' ? payload.input : payload;
        task.input = { ...(task.input || {}), ...patch };
        task.status = 'pending';
      } else if (action === 'regenerate') {
        if (!['done', 'error'].includes(task.status)) {
          return json(res, 409, { detail: '仅已完成/失败的任务可重生成' });
        }
        if (run.status === 'canceled') {
          return json(res, 409, { detail: '任务已取消' });
        }
        if (task.kind === 'assemble') {
          return json(res, 400, { detail: '合成任务请走合成确认门' });
        }
        if ((task.attempt ?? 0) >= 3) {
          return json(res, 400, { detail: '已达最大重试次数(3)' });
        }
        const guidance = String((parsed.payload && parsed.payload.guidance) || '').trim();
        if (guidance) {
          const inp = { ...(task.input || {}) };
          const key = 'prompt' in inp ? 'prompt' : 'dialogue';
          const base = String(inp[key] || '');
          inp[key] = base ? `${base}, ${guidance}` : guidance;
          task.input = inp;
        }
        task.attempt = (task.attempt ?? 0) + 1;
        task.status = 'pending';
        if (['error', 'done', 'awaiting_assembly'].includes(run.status)) {
          run.status = 'running';
        }
      } else if (action === 'reprompt') {
        // MP33：反推提示词（对齐后端：仅图像/视频卡，未产出 409；prompt/negative 写回 input，卡片保持 done）
        if (!['image', 'video'].includes(task.kind)) {
          return json(res, 400, { detail: '仅图像/视频任务支持反推提示词' });
        }
        const out = task.output && typeof task.output === 'object' ? task.output : {};
        if (!(out.url || out.video_url || out.image_url || out.audio_url)) {
          return json(res, 409, { detail: '任务尚未产出,无法反推' });
        }
        const inp = { ...(task.input || {}) };
        inp.prompt = `反推:${inp.prompt || task.title || ''}`;
        inp.negative = 'blurry, watermark';
        task.input = inp;
      } else {
        return json(res, 422, { detail: `未知操作: ${action}` });
      }
      run.updated_at = new Date().toISOString();
      json(res, 200, task);
    });
    return;
  }
  // MP13：参考资产库（内存 CRUD；PATCH 仅非 null 字段生效，对齐后端契约）
  if (path === '/api/assets' && req.method === 'GET') {
    const kind = url.searchParams.get('kind');
    const list = kind ? assets.filter((a) => a.kind === kind) : assets;
    return json(res, 200, list);
  }
  if (path === '/api/assets' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const now = new Date().toISOString();
      const asset = {
        id: `asset-${++assetSeq}`,
        kind: parsed.kind ?? 'character',
        name: parsed.name ?? '',
        description: parsed.description ?? '',
        images: Array.isArray(parsed.images) ? parsed.images : [],
        nsfw: Boolean(parsed.nsfw),
        created_at: now,
        updated_at: now,
      };
      assets.push(asset);
      json(res, 200, asset);
    });
    return;
  }
  if (/^\/api\/assets\/[^/]+\/images\/\d+$/.test(path) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_1PX);
    return;
  }
  const assetMatch = path.match(/^\/api\/assets\/([^/]+)$/);
  if (assetMatch) {
    const asset = assets.find((a) => a.id === assetMatch[1]);
    if (!asset) return json(res, 404, { detail: '资产不存在' });
    if (req.method === 'GET') return json(res, 200, asset);
    if (req.method === 'DELETE') {
      assets = assets.filter((a) => a.id !== asset.id);
      return json(res, 200, { ok: true, id: asset.id });
    }
    if (req.method === 'PATCH') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        for (const key of ['kind', 'name', 'description', 'images', 'nsfw']) {
          if (parsed[key] !== null && parsed[key] !== undefined) asset[key] = parsed[key];
        }
        asset.updated_at = new Date().toISOString();
        json(res, 200, asset);
      });
      return;
    }
  }
  if (path === '/api/jobs' && req.method === 'GET') {
    jobsCalls += 1;
    // MP15：limit/offset 服务端切片（对齐后端：limit 1-200 默认 50、offset ≥0 默认 0、越界返回 []）
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const rawOffset = parseInt(url.searchParams.get('offset') ?? '', 10);
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
    // MP16：kind 服务端过滤（逗号分隔多值，strip 去空白，空=全部；对齐后端 Job.kind.in_(kinds)）
    const kindParam = url.searchParams.get('kind') ?? '';
    const kinds = kindParam.split(',').map((k) => k.trim()).filter(Boolean);
    const all = jobsCalls <= 6 ? [runningJob, ...libraryJobs] : libraryJobs;
    const filtered = kinds.length > 0 ? all.filter((j) => kinds.includes(j.kind)) : all;
    return json(res, 200, filtered.slice(offset, offset + limit));
  }
  // MP29：作业进度 SSE（对齐后端 GET /api/jobs/{prompt_id}/events?client_id=&worker=）
  // 仅 __seed sseJobs 登记过的 prompt_id 有流（对齐「仅会话内提交作业可起流」）；未登记 404
  // 帧节奏 300ms：走查可断言进度条推进/预警图标/终态翻转；终态帧写出前同步翻列表内存态
  const jobEventsMatch = path.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (jobEventsMatch && req.method === 'GET') {
    const promptId = decodeURIComponent(jobEventsMatch[1]);
    const spec = sseJobs.find((s) => s.prompt_id === promptId);
    if (!spec) return json(res, 404, { detail: 'mock 无此作业 SSE 种子' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const frames = [];
    const pushProgress = (v) => frames.push({ event: 'progress', data: { value: v, max: 10 } });
    if (spec.scenario === 'warning') {
      pushProgress(1);
      pushProgress(3);
      frames.push({ event: 'quality_warning', data: { quality_score: 41, issues: ['画面模糊'] } });
      pushProgress(5);
      pushProgress(7);
      pushProgress(9);
      frames.push({ event: 'done', data: { images: ['outputs/a.png'] } });
    } else if (spec.scenario === 'error') {
      // MP9 微信轮：进度帧加密到 6 帧（窗口 ≈1.8s）——mp 自动化采样为多轮 IPC 往返，
      // 2 帧 600ms 窗口会漏采进度条；终态语义不变（H5 走查 mutation 侦测不受影响）
      pushProgress(2);
      pushProgress(3);
      pushProgress(4);
      pushProgress(5);
      pushProgress(6);
      pushProgress(7);
      frames.push({ event: 'error', data: { message: '执行失败：节点超时' } });
    } else {
      pushProgress(1);
      pushProgress(3);
      pushProgress(5);
      pushProgress(7);
      pushProgress(9);
      frames.push({ event: 'done', data: { images: ['outputs/a.png'] } });
    }
    let i = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (i >= frames.length) {
        res.end();
        return;
      }
      const f = frames[i];
      if (f.event === 'done' || f.event === 'error') {
        // 终态帧写出前翻转列表内存态（紧随的列表刷新即见终态/产物）
        const job = libraryJobs.find((j) => j.prompt_id === promptId);
        if (job) {
          job.status = f.event === 'done' ? 'done' : 'error';
          if (f.event === 'done') job.results = [...f.data.images];
        }
      }
      res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
      i += 1;
      setTimeout(tick, 300);
    };
    tick();
    return;
  }
  if (/^\/api\/jobs\/[^/]+\/versions$/.test(path)) return json(res, 200, [doneJob, doneJobV2]);
  // MP25：DELETE 真删内存（走查断言列表减项）；magic id 含 'fail' 注入 500（部分失败分支）
  const jobDelMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(jobDelMatch[1]);
    if (id.includes('fail')) return json(res, 500, { detail: 'mock 注入删除失败' });
    const idx = libraryJobs.findIndex((j) => j.id === id);
    if (idx >= 0) libraryJobs.splice(idx, 1);
    res.writeHead(204);
    res.end();
    return;
  }
  if (path.startsWith('/outputs/')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_1PX);
    return;
  }
  json(res, 404, { detail: 'mock 未覆盖: ' + req.method + ' ' + path });
});

server.listen(9800, () => console.log('[mock-api] http://localhost:9800'));
