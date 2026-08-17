/**
 * 业务端点（逐条对齐 Mobile lib/api.ts，契约已读 apps/api 源码验证）
 */
import {
  ApiError,
  apiFetch,
  apiUpload,
  buildRequestHeaders,
  friendlyMessage,
  LONG_TIMEOUT_MS,
  mediaUrl,
  setToken,
} from './client';
import { resolveApiBase } from './config';
import { createSseParser } from '@/utils/sse';
import type {
  AceMusicRequest,
  AgentChatImage,
  AgentChatMessage,
  AgentEvent,
  AgentPlanEditOp,
  AgentRunCancelResult,
  AgentRunDetail,
  AgentRunPlanResult,
  AgentRunResult,
  AgentRunResumeResult,
  AgentRunSseEvent,
  AgentRunSummary,
  AgentRunTask,
  AgentResumeBody,
  AgentTaskActionBody,
  AgentSessionDetail,
  AgentSessionSummary,
  AssetCreateBody,
  AssetItem,
  AssetKind,
  AssetPatchBody,
  AuthResult,
  AvatarTalkRequest,
  DocItem,
  EngineInfo,
  GenerateResponse,
  H3I2VRequest,
  H3T2VRequest,
  Img2ImgRequest,
  JobItem,
  JobSseEvent,
  LongCatContinueRequest,
  LongCatI2VRequest,
  LongCatT2VRequest,
  Ltx25I2VRequest,
  Ltx25T2VRequest,
  LtxNsfwI2VRequest,
  LtxNsfwLipsyncRequest,
  LtxNsfwT2VRequest,
  MeResult,
  OptimizeResult,
  RerunRequest,
  RerunResponse,
  ReverseResult,
  Txt2ImgRequest,
  UploadImageResult,
  WanAnimateRequest,
  WanVaceRequest,
  WechatLoginRequest,
} from '@/types/api';

/**
 * 登录：POST /api/auth/login
 * 🔒 响应字段是 token（不是 access_token），缺失即视为协议错误，防回归
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  const data = await apiFetch<AuthResult & { access_token?: string }>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new ApiError(0, '登录响应缺少 token 字段（协议不符）');
  }
  setToken(data.token);
  return { token: data.token, user: data.user };
}

export function logout(): void {
  setToken(null);
}

/**
 * 微信登录：POST /api/auth/wechat（MP31；响应与 /auth/login 完全同形 {token, user}）
 * dev 过渡：后端 TOIV_WECHAT_DEV_BYPASS=1 时 code 直通（openid="dev-{code}"）
 * token 落库方式照抄 login()：缺 token 即协议错误，setToken 后返回
 */
export async function wechatLogin(code: string): Promise<AuthResult> {
  const body: WechatLoginRequest = { code };
  const data = await apiFetch<AuthResult & { access_token?: string }>('/api/auth/wechat', {
    method: 'POST',
    body,
  });
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new ApiError(0, '登录响应缺少 token 字段（协议不符）');
  }
  setToken(data.token);
  return { token: data.token, user: data.user };
}

/** 拉取当前登录用户：GET /api/auth/me（冷启动校验 token，401 即强制重登） */
export async function fetchMe(): Promise<MeResult> {
  return apiFetch<MeResult>('/api/auth/me');
}

// ── 生成主流程 ──

/**
 * 引擎注册表：GET /api/models/engines → { engines, count }
 * NSFW 引擎由后端按 X-NSFW 上下文过滤，前端不做判断
 */
export async function fetchEngines(): Promise<EngineInfo[]> {
  const data = await apiFetch<{ engines?: EngineInfo[] }>('/api/models/engines');
  return data.engines ?? [];
}

/** 文生图提交：POST /api/generate/txt2img（服务端后台落库，客户端轮询 /api/jobs） */
export async function submitTxt2Img(params: Txt2ImgRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/txt2img', {
    method: 'POST',
    body: params,
  });
}

// ── 图生图链路 ──

/**
 * 参考图上传：POST /api/upload?kind=<kind>[&worker=<pin>]（multipart，字段名 image）
 * ≤20MB / 扩展名+魔数白名单由后端兜底（415），客户端在选图处先验
 * pinWorker：互钉上传落点（wan-vace 第 2-4 张钉第 1 张 worker）
 */
export async function uploadImage(
  filePath: string,
  kind: string = 'img2img',
  pinWorker?: string,
): Promise<UploadImageResult> {
  const pin = pinWorker ? `&worker=${encodeURIComponent(pinWorker)}` : '';
  return apiUpload<UploadImageResult>(
    `/api/upload?kind=${encodeURIComponent(kind)}${pin}`,
    filePath,
  );
}

/**
 * 驱动视频上传：POST /api/upload?kind=<kind>[&worker=<pin>]
 * multipart 字段名仍为 image（后端契约）；mp4/mov/webm 魔数嗅探 ≤200MB（413/415 兜底）
 * pinWorker：wan-animate 驱动视频钉参考图落点，保证生成同机
 */
export async function uploadVideo(
  filePath: string,
  kind: string,
  pinWorker?: string,
): Promise<UploadImageResult> {
  const pin = pinWorker ? `&worker=${encodeURIComponent(pinWorker)}` : '';
  return apiUpload<UploadImageResult>(
    `/api/upload?kind=${encodeURIComponent(kind)}${pin}`,
    filePath,
  );
}

/**
 * 驱动音频上传：POST /api/upload?kind=<kind>[&worker=<pin>]
 * multipart 字段名仍为 image（后端契约）；wav/mp3/m4a/ogg/flac 魔数嗅探 ≤20MB（413/415 兜底）
 * pinWorker：ltx-nsfw-lipsync 驱动音频钉参考图落点，保证口型同步生成同机（无转运）
 */
export async function uploadAudio(
  filePath: string,
  kind: string,
  pinWorker?: string,
): Promise<UploadImageResult> {
  const pin = pinWorker ? `&worker=${encodeURIComponent(pinWorker)}` : '';
  return apiUpload<UploadImageResult>(
    `/api/upload?kind=${encodeURIComponent(kind)}${pin}`,
    filePath,
  );
}

/**
 * 反推提示词：POST /api/reverse（multipart，字段名 file——非 image，与 /api/upload 区分）
 * 图片/视频 → VLM 反推英文 prompt（+negative 仅图像）；X-NSFW 跟随全局意图走 JoyCaption 专线
 * 长任务：VLM 首 token 慢，uni.uploadFile 固定 180s 超时（LONG_TIMEOUT_MS）
 */
export async function reversePrompt(filePath: string): Promise<ReverseResult> {
  const data = await apiUpload<ReverseResult & { negative?: string | null }>(
    '/api/reverse',
    filePath,
    'file',
  );
  return { kind: data.kind, prompt: data.prompt, negative: data.negative ?? null };
}

/**
 * 优化提示词：POST /api/optimize（契约已读 apps/api/app/routes/optimize.py）
 * 口语化输入 → LLM 按题材扩写专业英文 prompt（negative 仅 image/image_edit/video 类返回）
 * kind 跟随当前选中引擎的 kind（image/video/audio 直通，后端按 kind 切系统提示）
 * model/style/agent_id/style_hint 为 Web 高阶入参（模型族方言/智能体人格），移动端本期走默认
 * 502 优化失败 / 503 LLM 不可达由 apiFetch 透传人话；negative 缺省归一化为 null
 */
export async function optimizePrompt(params: {
  prompt: string;
  kind: string;
}): Promise<OptimizeResult> {
  const data = await apiFetch<OptimizeResult & { negative?: string | null }>('/api/optimize', {
    method: 'POST',
    body: { prompt: params.prompt, kind: params.kind },
  });
  return { optimized: data.optimized, negative: data.negative ?? null };
}

/**
 * 图生图提交：POST /api/generate/img2img
 * image/worker 必须来自同一次 uploadImage 响应（生成与参考图同机）
 */
export async function submitImg2Img(params: Img2ImgRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/img2img', {
    method: 'POST',
    body: params,
  });
}

// ── SFW 视频引擎链路（视频生成慢，统一走 LONG 180s 超时档）──

/** LTX 2.5 文生视频：POST /api/ltx25/t2v（422 detail 数组由 client 展开首条 msg） */
export async function submitLtx25T2V(params: Ltx25T2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/ltx25/t2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** LTX 2.5 图生视频：POST /api/ltx25/i2v（image/worker 来自 uploadImage kind=ltx_i2v） */
export async function submitLtx25I2V(params: Ltx25I2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/ltx25/i2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** Wan2.2 动作迁移：POST /api/wan/animate（image+video 互钉同 worker） */
export async function submitWanAnimate(params: WanAnimateRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/wan/animate', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** Wan2.1 VACE 多参考视频：POST /api/wan/vace（images 1-4 张，worker=第一张落点） */
export async function submitWanVace(params: WanVaceRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/wan/vace', {
    method: 'POST',
    body: params,
    long: true,
  });
}

// ── H3 / LongCat / ACE 引擎链路（MP11；统一 LONG 180s 超时档）──

/** MiniMax H3 文生视频：POST /api/h3/t2v（loras 数组透传；R18 LoRA 门控在后端） */
export async function submitH3T2V(params: H3T2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/h3/t2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** MiniMax H3 图生视频：POST /api/h3/i2v（image/worker 来自 uploadImage kind=h3_i2v，后端转运实例） */
export async function submitH3I2V(params: H3I2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/h3/i2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** LongCat 文生视频：POST /api/longcat/t2v（长镜头引擎；无 cfg，蒸馏链路固定 1.0） */
export async function submitLongCatT2V(params: LongCatT2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/longcat/t2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** LongCat 图生视频：POST /api/longcat/i2v（image/worker 来自 uploadImage，后端转运 :8197 实例） */
export async function submitLongCatI2V(params: LongCatI2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/longcat/i2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** LongCat 视频续写：POST /api/longcat/continue（width/height/fps 省略时后端向源视频实测对齐） */
export async function submitLongCatContinue(
  params: LongCatContinueRequest,
): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/longcat/continue', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** ACE-Step 文生音乐：POST /api/generate/audio（tags=风格标签；产物 MP3，歌词留空=纯音乐） */
export async function submitAceMusic(params: AceMusicRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/audio', {
    method: 'POST',
    body: params,
    long: true,
  });
}

// ── R18 视频引擎链路（MP12，契约已读 apps/api 源码验证：routes/video.py；仅 NSFW 上下文放行）──

/** LTX-2.3 文生视频（R18）：POST /api/generate/ltx-t2v → GenerateResponse（10Eros 底模，long 超时） */
export async function submitLtxNsfwT2V(params: LtxNsfwT2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/ltx-t2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** LTX-2.3 图生视频（R18）：POST /api/generate/ltx-i2v（image/worker 来自 uploadImage kind=ltx_i2v） */
export async function submitLtxNsfwI2V(params: LtxNsfwI2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/ltx-i2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/** LTX-2.3 口型同步（R18）：POST /api/generate/ltx-lipsync（image/audio 互钉同 worker） */
export async function submitLtxNsfwLipsync(params: LtxNsfwLipsyncRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/ltx-lipsync', {
    method: 'POST',
    body: params,
    long: true,
  });
}

// h3-nsfw-t2v / h3-nsfw-i2v 复用 submitH3T2V / submitH3I2V（与 SFW 同一 POST /api/h3/* 提交链路）

// ── LongCat-Avatar 数字人链路（MP14，契约已读 apps/api 源码验证：routes/avatar_studio.py）──

/**
 * LongCat-Avatar 数字人：POST /api/avatar/talk（SFW 引擎，非 /api/generate 路径）
 * image/audio 均经 uploadImage/uploadAudio kind=avatar 上传（互钉同 worker），后端转运 :8197 实例
 */
export async function submitAvatarTalk(params: AvatarTalkRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/avatar/talk', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * 作业列表：GET /api/jobs?limit&offset&status&kind → JobItem[]（原样数组，最新在前）
 * 轮询载体（小程序无 EventSource，且后端已做服务端追踪，轮询不丢结果）
 * offset（MP15）：作品库无限分页游标，0/缺省不序列化（既有调用方零感知）；
 * hasMore 启发式：本页返回数 === limit 即可能还有下一页，越界返回 []
 * kind（MP16）：服务端媒体类型过滤，逗号分隔多值（如 "txt2img,wan_t2v"），空=全部
 */
export async function listJobs(
  options: { limit?: number; offset?: number; status?: string; kind?: string } = {},
): Promise<JobItem[]> {
  const { limit = 50, offset = 0, status = '', kind = '' } = options;
  const qs =
    `?limit=${limit}` +
    `${offset > 0 ? `&offset=${offset}` : ''}` +
    `${status ? `&status=${encodeURIComponent(status)}` : ''}` +
    `${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`;
  return apiFetch<JobItem[]>(`/api/jobs${qs}`);
}

/** 删除作业：DELETE /api/jobs/{id}（仅本人；产物文件由后端另行清理） */
export async function deleteJob(jobId: string): Promise<void> {
  await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}

/**
 * 精确重生：POST /api/jobs/{key}/rerun
 * has_params=false 的旧作品后端 400；不支持类型 400；explicit 缺 seed 422
 */
export async function rerunJob(
  jobKey: string,
  body: RerunRequest = {},
): Promise<RerunResponse> {
  return apiFetch<RerunResponse>(`/api/jobs/${encodeURIComponent(jobKey)}/rerun`, {
    method: 'POST',
    body,
  });
}

/** 同根版本链：GET /api/jobs/{key}/versions（时间升序，主站过滤 R18） */
export async function fetchVersions(jobKey: string): Promise<JobItem[]> {
  return apiFetch<JobItem[]>(`/api/jobs/${encodeURIComponent(jobKey)}/versions`);
}

// ── 参考资产库（MP13，契约已读 apps/api 源码验证：routes/reference_assets.py）──

/** 资产列表：GET /api/assets[?kind=]（仅当前用户；SFW 上下文后端滤掉 nsfw 资产） */
export async function listAssets(kind?: AssetKind): Promise<AssetItem[]> {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  return apiFetch<AssetItem[]>(`/api/assets${qs}`);
}

/** 创建资产：POST /api/assets（images 1-4 张上传句柄，本地先验后后端 422 兜底） */
export async function createAsset(body: AssetCreateBody): Promise<AssetItem> {
  return apiFetch<AssetItem>('/api/assets', { method: 'POST', body });
}

/** 单查：GET /api/assets/{id}（他人/nsfw 在 SFW 上下文一律 404，防枚举） */
export async function getAsset(id: string): Promise<AssetItem> {
  return apiFetch<AssetItem>(`/api/assets/${encodeURIComponent(id)}`);
}

/** 部分更新：PATCH /api/assets/{id}（仅传入字段生效，由 buildAssetPatch 产出差量） */
export async function updateAsset(id: string, patch: AssetPatchBody): Promise<AssetItem> {
  return apiFetch<AssetItem>(`/api/assets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/** 删除：DELETE /api/assets/{id} → {ok, id}（只删 DB 记录，不动 worker 文件本体） */
export async function deleteAsset(id: string): Promise<void> {
  await apiFetch(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * 资产参考图回显 URL：GET /api/assets/{id}/images/{index}
 * 媒体标签无法带请求头，token query 由 mediaUrl 自动拼（对齐产物 mediaUrl 模式）
 */
export function assetImageUrl(id: string, index: number): string {
  return mediaUrl(`/api/assets/${encodeURIComponent(id)}/images/${index}`);
}

// ── 文档挂载（MP20，契约已读 apps/api 源码验证：routes/documents.py / services/docs.py）──

/** 文档列表：GET /api/docs → DocItem[]（created_at 倒序由后端保证，documents.py list_docs） */
export async function listDocs(): Promise<DocItem[]> {
  return apiFetch<DocItem[]>('/api/docs');
}

/**
 * 文档上传：POST /api/docs/upload（multipart，字段名 file——与 /api/upload 的 image 区分）→ 201 DocItem
 * 仅 pdf/docx/txt/md ≤50MB（后端 400/413/422 兜底），客户端在选文档处先验（utils/doc.ts validateDocFile）
 * 大文件解析 CPU 密集（documents.py 线程池秒级）+ embedding 索引，apiUpload 固定 LONG 180s 超时档
 */
export async function uploadDoc(filePath: string): Promise<DocItem> {
  return apiUpload<DocItem>('/api/docs/upload', filePath, 'file');
}

/** 删除文档：DELETE /api/docs/{id} → {ok:true}（元数据 + 落盘原文/索引文件一并清理；404 不泄露存在性） */
export async function deleteDoc(docId: string): Promise<void> {
  await apiFetch(`/api/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
}

// ── 对话助手（MP19，契约已读 apps/api/app/routes/agent.py / agent/runner.py 源码验证）──

/**
 * uni.request 的 enableChunked 分块回调（微信原生 wx.request 能力 / uni-h5 fetch+ReadableStream）
 * @dcloudio/types 的 RequestTask 未声明 onChunkReceived，按运行时真实形状显式收窄
 */
interface ChunkedRequestTask {
  abort(): void;
  onHeadersReceived(
    cb: (res: { header?: Record<string, unknown>; statusCode?: number }) => void,
  ): void;
  onChunkReceived(cb: (res: { data: ArrayBuffer }) => void): void;
}

export interface AgentChatStreamResult {
  /** 响应头 X-Agent-Session-Id（新会话=后端新建 id；缺头为 null，UI 兜底不崩） */
  sessionId: string | null;
}

export interface AgentChatStreamHandle {
  promise: Promise<AgentChatStreamResult>;
  /** 停止生成：中断底层请求（promise 以「已停止生成」reject） */
  abort(): void;
}

/** 响应头大小写不敏感取值（H5 fetch Headers 一律小写，微信端按服务端原样） */
function headerValue(header: Record<string, unknown> | undefined, name: string): string | null {
  if (!header) return null;
  for (const key of Object.keys(header)) {
    if (key.toLowerCase() === name) {
      const value = header[key];
      return typeof value === 'string' ? value : null;
    }
  }
  return null;
}

/**
 * 对话流式请求：POST /api/agent/chat（SSE，Content-Type text/event-stream）
 * - 帧格式 `event: msg\ndata: {AgentEvent JSON}\n\n`，结束帧 `event: done\ndata: {}\n\n`
 * - onEvent 逐事件回调（done 帧不上抛）；session_id 续聊携带、新会话省略
 * - documentIds（MP20）：挂载文档 id 上行（agent.py document_ids ≤8 后端硬上限兜底），空数组不带字段
 * - image（MP30）：用户附图句柄 {filename,worker}（uploadImage kind=img2img 上传所得），
 *   runner 注入系统提示并把 attachment 传给 edit_image/generate_3d 工具；无附图不带字段
 * - 非 2xx：onHeadersReceived 标记 statusCode，success 后按人话体系 reject（与 apiFetch 同套映射）
 * - abort → 「已停止生成」；超时档走 LONG_TIMEOUT_MS（LLM 首 token 慢，对齐长任务语义）
 */
export function agentChatStream(
  params: {
    messages: AgentChatMessage[];
    sessionId?: string;
    documentIds?: string[];
    image?: AgentChatImage;
  },
  onEvent: (event: AgentEvent) => void,
): AgentChatStreamHandle {
  const url = `${resolveApiBase()}/api/agent/chat`;
  const header = buildRequestHeaders({ accept: 'text/event-stream', json: true });
  const body: {
    messages: AgentChatMessage[];
    session_id?: string;
    document_ids?: string[];
    image?: AgentChatImage;
  } = {
    messages: params.messages,
  };
  if (params.sessionId) body.session_id = params.sessionId;
  // 空数组不带字段（对齐后端 default_factory=list 语义，少传少错）
  if (params.documentIds && params.documentIds.length > 0) body.document_ids = params.documentIds;
  if (params.image) body.image = params.image;

  let httpStatus: number | null = null;
  let sessionId: string | null = null;

  const parser = createSseParser((event, data) => {
    if (event === 'done') return; // 结束帧仅标记流终止（success 收尾），不上抛业务层
    if (event !== 'msg') return; // 未知事件名容错忽略
    try {
      onEvent(JSON.parse(data) as AgentEvent);
    } catch {
      // 畸形 JSON 帧跳过，不中断流
    }
  });

  let task: ChunkedRequestTask | null = null;
  const promise = new Promise<AgentChatStreamResult>((resolve, reject) => {
    const rawTask = uni.request({
      url,
      method: 'POST',
      header,
      data: body,
      enableChunked: true,
      responseType: 'text',
      timeout: LONG_TIMEOUT_MS,
      success: () => {
        if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
          reject(new ApiError(httpStatus, friendlyMessage(httpStatus, '')));
          return;
        }
        parser.end();
        resolve({ sessionId });
      },
      fail: (err) => {
        const msg = err.errMsg ?? '';
        if (msg.includes('abort')) {
          reject(new ApiError(0, '已停止生成'));
          return;
        }
        if (msg.includes('timeout') || msg.includes('timed out')) {
          reject(new ApiError(0, '请求超时，请检查网络后重试'));
          return;
        }
        reject(new ApiError(0, '网络连接失败，请检查网络'));
      },
    });
    task = rawTask as unknown as ChunkedRequestTask;
    task.onHeadersReceived((res) => {
      httpStatus = res.statusCode ?? null;
      sessionId = headerValue(res.header, 'x-agent-session-id');
    });
    task.onChunkReceived((res) => {
      parser.push(res.data);
    });
  });

  return {
    promise,
    abort: () => task?.abort(),
  };
}

/** 会话列表：GET /api/agent/sessions → AgentSessionSummary[]（updated_at 倒序） */
export async function listAgentSessions(): Promise<AgentSessionSummary[]> {
  return apiFetch<AgentSessionSummary[]>('/api/agent/sessions');
}

/** 会话回放：GET /api/agent/sessions/{sid}（messages id 升序；非本人/R18 越界 404 不泄露） */
export async function getAgentSession(sid: string): Promise<AgentSessionDetail> {
  return apiFetch<AgentSessionDetail>(`/api/agent/sessions/${encodeURIComponent(sid)}`);
}

/** 删除会话：DELETE /api/agent/sessions/{sid}（连同全部消息事件） */
export async function deleteAgentSession(sid: string): Promise<void> {
  await apiFetch(`/api/agent/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
}

/**
 * 分叉会话：POST /api/agent/sessions/{sid}/fork → 新会话摘要（MP24）
 * body 仅在有 atMessageId 时带 {at_message_id}（截断复制到该消息含），否则空 body 全量复制
 * 新会话继承源 title/nsfw；at_message_id 不在会话内 404「消息不存在」按人话体系透传
 */
export async function forkAgentSession(
  sid: string,
  atMessageId?: number,
): Promise<AgentSessionSummary> {
  return apiFetch<AgentSessionSummary>(
    `/api/agent/sessions/${encodeURIComponent(sid)}/fork`,
    {
      method: 'POST',
      body: atMessageId === undefined ? undefined : { at_message_id: atMessageId },
    },
  );
}

// ── Agent 团队监控（MP21 一期：只读 + 取消；plan 编辑/resume/task action 后置二期）
//    契约已读 apps/api/app/routes/agent_team.py + services/agent_team_exec.py 源码验证 ──

/**
 * run 列表：GET /api/agent-runs?status=&limit= → AgentRunSummary[]（created_at 倒序）
 * status 为精确匹配单值（后端 Query(default="")，空=全部；多值过滤二期再议）
 */
export async function listAgentRuns(status?: string): Promise<AgentRunSummary[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<AgentRunSummary[]>(`/api/agent-runs${qs}`);
}

/** run 详情：GET /api/agent-runs/{id}（计划 DAG + 全任务卡片；非本人 404 不泄露存在性） */
export async function getAgentRun(runId: string): Promise<AgentRunDetail> {
  return apiFetch<AgentRunDetail>(`/api/agent-runs/${encodeURIComponent(runId)}`);
}

/**
 * 取消 run：POST /api/agent-runs/{id}/cancel → {run_id, status:'canceled'}
 * 仅 planning/awaiting_confirm/running/awaiting_assembly 可取消，其余 409 人话透传
 */
export async function cancelAgentRun(runId: string): Promise<AgentRunCancelResult> {
  return apiFetch<AgentRunCancelResult>(`/api/agent-runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

/**
 * 确认门裁决：POST /api/agent-runs/{id}/resume → {run_id, status}
 * - gate=plan 仅 awaiting_confirm/planning 可裁决；gate=assembly 仅 awaiting_assembly（否则 409 人话透传）
 * - approve 通过进 running（计划门启动图执行/合成门投递合成裁决）；
 *   reject 打回（计划门回 planning 重规划，feedback 记入 run.error；合成门回 running 可单卡重生成）
 * - modify 仅记录裁决，run 保持挂起态（实际改动走 POST /plan 计划编辑，MP23 起由计划门编辑面板组合投递）
 */
export async function resumeAgentRun(
  runId: string,
  body: AgentResumeBody,
): Promise<AgentRunResumeResult> {
  return apiFetch<AgentRunResumeResult>(`/api/agent-runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    body,
  });
}

/**
 * 计划编辑：POST /api/agent-runs/{id}/plan（Flowith 式改/删/加，MP23）
 * body {tasks: ops}；仅 awaiting_confirm 可投（否则 409 人话透传），任务 id 不存在 404 人话透传
 * 返回 {run_id, plan:{tasks}}（tasks 为 _task_brief 简报，无 input/output——
 * 调用方用 mergePlanTasks 合并进本地详情，保留已有卡片详情字段；同帧 plan SSE 事件随后到达，合并幂等）
 */
export async function updateAgentRunPlan(
  runId: string,
  ops: AgentPlanEditOp[],
): Promise<AgentRunPlanResult> {
  return apiFetch<AgentRunPlanResult>(`/api/agent-runs/${encodeURIComponent(runId)}/plan`, {
    method: 'POST',
    body: { tasks: ops },
  });
}

/**
 * 成片结果：GET /api/agent-runs/{id}/result（MP23）
 * 仅 run.status === 'done'，否则 409「任务尚未完成」人话透传（详情页终态竞态下调用方静默忽略）
 * final_url 取自 assemble done 卡 output.url；duration_sec 为 video/image 卡 input.duration_sec 合计
 */
export async function getAgentRunResult(runId: string): Promise<AgentRunResult> {
  return apiFetch<AgentRunResult>(`/api/agent-runs/${encodeURIComponent(runId)}/result`);
}

/**
 * 卡片级干预：POST /api/agent-runs/{id}/tasks/{tid}/action → 直接返回任务详情（顶层即卡片字段，无包装）
 * - edit：payload={input:{...}} 合并进任务 input，卡片回 pending 待重跑
 * - regenerate：payload={guidance?} 引导词拼进主文案；仅 done/error 可重生（409/400 人话透传）
 * - approve：卡片置 approved
 * - upload：payload={url} 替换产物（仅本地产物 /api/studio/files/{name}；合成卡 400）
 * - reprompt：反推产物提示词写回 input（仅图像/视频卡；未产出 409/文件丢失 404；卡片保持 done）
 */
export async function agentTaskAction(
  runId: string,
  taskId: string,
  body: AgentTaskActionBody,
): Promise<AgentRunTask> {
  return apiFetch<AgentRunTask>(
    `/api/agent-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/action`,
    {
      method: 'POST',
      body,
    },
  );
}

/**
 * 卡片产物直传替换（MP33）：POST /api/agent-runs/{id}/tasks/{tid}/upload（multipart，字段名 file）
 * 本地文件 → Studio 输出目录 → 卡片回 done；三重白名单/413/415 人话由后端兜底透出
 * 返回任务详情（顶层即卡片字段，与 agentTaskAction 同形，调用方局部替换）
 */
export async function uploadAgentTaskAsset(
  runId: string,
  taskId: string,
  filePath: string,
): Promise<AgentRunTask> {
  return apiUpload<AgentRunTask>(
    `/api/agent-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/upload`,
    filePath,
    'file',
  );
}

export interface AgentRunEventsHandle {
  /** 流正常结束（服务端终态关流）resolve；非 2xx/网络错/abort reject */
  promise: Promise<void>;
  /** 停止监听：中断底层请求（promise 以「已停止监听」reject） */
  abort(): void;
}

/**
 * 订阅 run 事件流：GET /api/agent-runs/{id}/events?after=（SSE，sse_starlette 轮询 AgentEvent 表）
 * - 帧格式 `event: <type>\ndata: {payload JSON}\n\n`；`: ping` 保活注释由解析器忽略
 * - 与 MP19 agentChatStream 不同：此处 done 是业务事件（run 完成）原样上抛，
 *   流结束以 success 回调为准（终态后服务端关流），无结束标记帧
 * - 事件载荷类型守卫：JSON 解析失败/非对象一律跳过，不中断流
 * - after 为断点续传游标（事件 id > after 才推）；重连传 0 全量重放（合并函数幂等，对齐 Web）
 * - 认证走 Authorization 头（uni.request 可带头，无需 ?token= query——后端两者都收）
 * - abort → 「已停止监听」；超时档 LONG（事件流长挂，靠 ping 保活；超时/断线由页面重连）
 */
export function watchAgentRunEvents(
  runId: string,
  after: number,
  onEvent: (event: AgentRunSseEvent) => void,
): AgentRunEventsHandle {
  const url = `${resolveApiBase()}/api/agent-runs/${encodeURIComponent(runId)}/events?after=${after}`;
  const header = buildRequestHeaders({ accept: 'text/event-stream' });

  let httpStatus: number | null = null;

  const parser = createSseParser((event, data) => {
    if (event === 'message') return; // 无名事件非本端点业务（后端恒带 event 名），容错忽略
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return; // 畸形 JSON 帧跳过，不中断流
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    onEvent({ type: event, data: payload as Record<string, unknown> });
  });

  let task: ChunkedRequestTask | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    const rawTask = uni.request({
      url,
      method: 'GET',
      header,
      enableChunked: true,
      responseType: 'text',
      timeout: LONG_TIMEOUT_MS,
      success: () => {
        if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
          reject(new ApiError(httpStatus, friendlyMessage(httpStatus, '')));
          return;
        }
        parser.end();
        resolve();
      },
      fail: (err) => {
        const msg = err.errMsg ?? '';
        if (msg.includes('abort')) {
          reject(new ApiError(0, '已停止监听'));
          return;
        }
        if (msg.includes('timeout') || msg.includes('timed out')) {
          reject(new ApiError(0, '请求超时，请检查网络后重试'));
          return;
        }
        reject(new ApiError(0, '网络连接失败，请检查网络'));
      },
    });
    task = rawTask as unknown as ChunkedRequestTask;
    task.onHeadersReceived((res) => {
      httpStatus = res.statusCode ?? null;
    });
    task.onChunkReceived((res) => {
      parser.push(res.data);
    });
  });

  return {
    promise,
    abort: () => task?.abort(),
  };
}

// ── 作业进度 SSE（MP29，契约已读 apps/api/app/routes/jobs.py job_events 源码验证）──

export interface JobEventsHandle {
  /** 流正常结束（服务端终态关流）resolve；非 2xx/网络错/abort reject */
  promise: Promise<void>;
  /** 停止监听：中断底层请求（promise 以「已停止监听」reject） */
  abort(): void;
}

const JOB_SSE_EVENT_TYPES = new Set(['progress', 'done', 'error', 'quality_warning']);

/**
 * 订阅作业进度事件流：GET /api/jobs/{prompt_id}/events?client_id=&worker=（SSE）
 * - 后端把 ComfyUI WS 的 progress(value/max)/done({images})/error({message}) 转发为 SSE，
 *   done 前可能先推 quality_warning（视频质量评估低分；仅通知不阻塞 done）
 * - 会话内限制：client_id/worker 仅提交响应持有（JobItem 不持久化），
 *   故仅「本次会话内刚提交」的作业可起流，其余走既有轮询（job-sse-registry 登记/清除）
 * - 认证走 Authorization 头（与 watchAgentRunEvents 同源，后端 get_current_user 两者都收）
 * - 事件载荷类型守卫：JSON 解析失败/非对象一律跳过，不中断流；未知事件名容错忽略
 * - onOpen（可选）：2xx 响应头到达即触发（跟踪层 FSM 的 open 信号，判连接建立/重连快照窗）
 * - abort → 「已停止监听」；超时档 LONG（事件流长挂；看门狗/重连由跟踪层负责）
 */
export function streamJobEvents(
  promptId: string,
  creds: { clientId: string; worker: string },
  onEvent: (event: JobSseEvent) => void,
  onOpen?: () => void,
): JobEventsHandle {
  const url =
    `${resolveApiBase()}/api/jobs/${encodeURIComponent(promptId)}/events` +
    `?client_id=${encodeURIComponent(creds.clientId)}&worker=${encodeURIComponent(creds.worker)}`;
  const header = buildRequestHeaders({ accept: 'text/event-stream' });

  let httpStatus: number | null = null;

  const parser = createSseParser((event, data) => {
    if (!JOB_SSE_EVENT_TYPES.has(event)) return; // message/ping 等非本端点业务，容错忽略
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return; // 畸形 JSON 帧跳过，不中断流
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    onEvent({ type: event as JobSseEvent['type'], data: payload as Record<string, unknown> });
  });

  let task: ChunkedRequestTask | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    const rawTask = uni.request({
      url,
      method: 'GET',
      header,
      enableChunked: true,
      responseType: 'text',
      timeout: LONG_TIMEOUT_MS,
      success: () => {
        if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
          reject(new ApiError(httpStatus, friendlyMessage(httpStatus, '')));
          return;
        }
        parser.end();
        resolve();
      },
      fail: (err) => {
        const msg = err.errMsg ?? '';
        if (msg.includes('abort')) {
          reject(new ApiError(0, '已停止监听'));
          return;
        }
        if (msg.includes('timeout') || msg.includes('timed out')) {
          reject(new ApiError(0, '请求超时，请检查网络后重试'));
          return;
        }
        reject(new ApiError(0, '网络连接失败，请检查网络'));
      },
    });
    task = rawTask as unknown as ChunkedRequestTask;
    task.onHeadersReceived((res) => {
      httpStatus = res.statusCode ?? null;
      if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) onOpen?.();
    });
    task.onChunkReceived((res) => {
      parser.push(res.data);
    });
  });

  return {
    promise,
    abort: () => task?.abort(),
  };
}
