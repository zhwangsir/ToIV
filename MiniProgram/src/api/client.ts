/**
 * 统一 API 客户端（uni.request 实现，语义逐条对齐 Mobile lib/api.ts）
 * - token 存 uni storage（小程序无 SecureStore 等价物），内存镜像供 mediaUrl 同步取值
 * - NSFW 意图经 X-NSFW 头按请求注入，不动账户全局开关
 * - 超时：常规 30s，长任务（上传/合成）180s
 */
import { resolveApiBase } from './config';
import { getString, remove, setString } from '@/utils/storage';

const TOKEN_KEY = 'toiv_token';

/** 常规 JSON/轮询请求超时 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 长任务端点超时（上传 / VLM 解析 / ffmpeg 合成） */
export const LONG_TIMEOUT_MS = 180_000;

let nsfwIntent = false;

/** token 内存镜像：mediaUrl 拼媒体地址是同步调用，不能每次异步读 storage */
let cachedToken: string | null = null;

/** /nsfw 板块进入/退出时调用，按请求带 R18 放行标记 */
export function setNsfwIntent(on: boolean): void {
  nsfwIntent = on;
}

export function getToken(): string | null {
  cachedToken = getString(TOKEN_KEY);
  return cachedToken;
}

export function setToken(token: string | null): void {
  cachedToken = token;
  if (token) setString(TOKEN_KEY, token);
  else remove(TOKEN_KEY);
}

/**
 * 产物相对路径 → 可加载 URL（对齐 Web imageUrl：相对路径拼 base + ?token=）
 * 媒体标签无法带请求头，后端接受 query token；无 token 时原样返回（交由 401 兜底）
 */
export function mediaUrl(path: string): string {
  if (!path) return '';
  const abs = path.startsWith('http')
    ? path
    : `${resolveApiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!cachedToken) return abs;
  return `${abs}${abs.includes('?') ? '&' : '?'}token=${encodeURIComponent(cachedToken)}`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 状态码 → 人话（对齐 Mobile friendlyMessage，UI 直接展示）；MP19 流式请求复用同一套映射 */
export function friendlyMessage(status: number, fallback: string): string {
  if (status === 401) return '登录已过期，请重新登录';
  if (status === 403) return '没有权限执行此操作';
  if (status === 404) return '资源不存在或已被清理';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status >= 500) return '服务暂时不可用，请稍后重试';
  return fallback || '请求失败，请重试';
}

/**
 * 同源请求头构造（apiFetch 语义的头部子集：Bearer token + X-NSFW 全局意图）
 * MP19 流式请求（uni.request enableChunked）不走 apiFetch，但头部必须同源
 */
export function buildRequestHeaders(options: { accept?: string; json?: boolean } = {}): Record<string, string> {
  const header: Record<string, string> = { Accept: options.accept ?? 'application/json' };
  const token = getToken();
  if (token) header.Authorization = `Bearer ${token}`;
  if (nsfwIntent) header['X-NSFW'] = '1';
  if (options.json) header['Content-Type'] = 'application/json';
  return header;
}

export interface ApiFetchOptions {
  /**
   * 与 uni.request RequestOptions.method 对齐 + PATCH（MP13 资产库部分更新）
   * 注意：@dcloudio/types 的 method 联合类型不含 PATCH，调用处显式收窄强转；
   * H5（XHR）原生支持 PATCH，小程序基础库方法白名单以真机验证为准（走查环境为 H5）
   */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
  body?: unknown;
  /** 长任务端点置 true，超时放宽到 180s */
  long?: boolean;
  /** 单次请求覆盖 NSFW 意图（默认跟随全局意图） */
  nsfw?: boolean;
}

export function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = 'GET', body, long = false, nsfw } = options;
  const base = resolveApiBase();
  const url = path.startsWith('http') ? path : `${base}${path}`;

  const header: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) header.Authorization = `Bearer ${token}`;
  if (nsfw ?? nsfwIntent) header['X-NSFW'] = '1';
  if (body !== undefined) header['Content-Type'] = 'application/json';

  return new Promise<T>((resolve, reject) => {
    uni.request({
      url,
      // @dcloudio/types 的 method 联合类型不含 PATCH（MP13 起后端契约使用），运行时 H5/XHR 支持
      method: method as 'GET',
      header,
      data: body as never,
      timeout: long ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      success: (res) => {
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          if (status === 204) {
            resolve(undefined as T);
            return;
          }
          resolve(res.data as T);
          return;
        }
        let detail = '';
        const data = res.data as { detail?: unknown; message?: string } | null;
        if (data && typeof data === 'object') {
          // FastAPI 422 detail 为校验错误数组，展开首条 msg（对齐 Web _postLtx25/_postWan 模式）
          if (Array.isArray(data.detail)) {
            const first = data.detail[0] as { msg?: string } | undefined;
            detail = first?.msg ?? '';
          } else {
            detail = (data.detail as string | undefined) ?? data.message ?? '';
          }
        }
        reject(new ApiError(status, friendlyMessage(status, detail)));
      },
      fail: (err) => {
        const msg = err.errMsg ?? '';
        if (msg.includes('timeout') || msg.includes('timed out')) {
          reject(new ApiError(0, '请求超时，请检查网络后重试'));
          return;
        }
        reject(new ApiError(0, '网络连接失败，请检查网络'));
      },
    });
  });
}

/**
 * multipart 上传：POST /api/upload（字段名 image）/ POST /api/reverse（字段名 file）
 * uni.uploadFile 的 multipart 边界由运行时生成，不手设 Content-Type（对齐后端 UploadFile 解析）
 * X-NSFW：跟随全局 NSFW 意图注入（MP17 反推 JoyCaption 专线触发条件；对齐 apiFetch 语义）
 */
export function apiUpload<T>(path: string, filePath: string, name: string = 'image'): Promise<T> {
  const base = resolveApiBase();
  const url = path.startsWith('http') ? path : `${base}${path}`;

  const header: Record<string, string> = {};
  const token = getToken();
  if (token) header.Authorization = `Bearer ${token}`;
  if (nsfwIntent) header['X-NSFW'] = '1';

  return new Promise<T>((resolve, reject) => {
    uni.uploadFile({
      url,
      filePath,
      name,
      header,
      timeout: LONG_TIMEOUT_MS,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(res.data) as T);
          } catch {
            reject(new ApiError(0, '上传响应解析失败'));
          }
          return;
        }
        // 与 apiFetch 同源：优先透出后端人话 detail（413/415 等校验文案），再回落通用映射
        let detail = '';
        try {
          const data = JSON.parse(res.data) as { detail?: unknown; message?: string } | null;
          if (data && typeof data === 'object') {
            detail = (data.detail as string | undefined) ?? data.message ?? '';
          }
        } catch {
          /* 非 JSON 错误体：回落通用映射 */
        }
        reject(new ApiError(res.statusCode, friendlyMessage(res.statusCode, detail)));
      },
      fail: () => {
        reject(new ApiError(0, '网络连接失败，请检查网络'));
      },
    });
  });
}
