/**
 * uni 运行时 mock：node 环境跑逻辑层单测
 * 每个用例文件 beforeEach 调 installMockUni() 重置全局状态
 */

export interface MockRequestCall {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: unknown;
  timeout?: number;
}

/** MP19 流式请求（enableChunked）mock 响应：chunks 按序逐块推送 */
export interface MockChunkedResponse {
  statusCode: number;
  header?: Record<string, string>;
  chunks: Array<string | Uint8Array>;
}

interface MockUniState {
  storage: Map<string, string>;
  requestQueue: Array<{
    statusCode: number;
    data: unknown;
  }>;
  requestCalls: MockRequestCall[];
  requestError: { errMsg: string } | null;
  uploadResult: { statusCode: number; data: string } | null;
  uploadCalls: Array<{ url: string; filePath: string; name: string; header: Record<string, string> }>;
  chunkedQueue: MockChunkedResponse[];
  chunkedError: { errMsg: string } | null;
  /** MP28：downloadFile/showLoading/showToast/navigateTo 行为与调用捕获 */
  downloadResult: { statusCode: number; tempFilePath: string } | null;
  downloadError: { errMsg: string } | null;
  downloadCalls: Array<{ url: string }>;
  toastCalls: Array<{ title: string; icon?: string }>;
  loadingCalls: Array<{ title: string }>;
  hideLoadingCount: number;
  navigateCalls: string[];
  /** MP30：showActionSheet/chooseImage 行为与调用捕获 */
  actionSheetChoice: number | null;
  actionSheetCalls: Array<{ itemList: string[] }>;
  chooseImageResult: { tempFilePaths: string[]; tempFiles: Array<{ path: string; size: number }> } | null;
  chooseImageCalls: Array<{ count?: number; sizeType?: string[]; sourceType?: string[] }>;
  /** MP31：login/showModal 行为与调用捕获 */
  loginResult: { code: string } | null;
  loginError: { errMsg: string } | null;
  loginCalls: Array<{ provider?: string }>;
  modalCalls: Array<{ title?: string; content?: string; showCancel?: boolean }>;
}

const state: MockUniState = {
  storage: new Map(),
  requestQueue: [],
  requestCalls: [],
  requestError: null,
  uploadResult: null,
  uploadCalls: [],
  chunkedQueue: [],
  chunkedError: null,
  downloadResult: null,
  downloadError: null,
  downloadCalls: [],
  toastCalls: [],
  loadingCalls: [],
  hideLoadingCount: 0,
  navigateCalls: [],
  actionSheetChoice: null,
  actionSheetCalls: [],
  chooseImageResult: null,
  chooseImageCalls: [],
  loginResult: null,
  loginError: null,
  loginCalls: [],
  modalCalls: [],
};

/**
 * enableChunked 流式请求 mock 任务（MP19）
 * 真实运行时行为：onHeadersReceived → 逐块 onChunkReceived → success
 * 事件经 setTimeout 异步派发，保证调用方先同步注册完回调；abort 后续事件不再派发
 */
function makeChunkedTask(options: {
  success?: (res: { statusCode: number; data: unknown }) => void;
  fail?: (err: { errMsg: string }) => void;
}) {
  const headerCbs: Array<(res: { header: Record<string, string>; statusCode: number }) => void> = [];
  const chunkCbs: Array<(res: { data: ArrayBuffer }) => void> = [];
  let aborted = false;

  const encoder = new TextEncoder();
  const next = state.chunkedError ? null : state.chunkedQueue.shift();
  if (!state.chunkedError && !next) {
    throw new Error('[mock-uni] chunked 队列为空，用例需先 enqueueChunkedResponse');
  }

  setTimeout(() => {
    if (state.chunkedError) {
      if (!aborted) options.fail?.(state.chunkedError);
      return;
    }
    const res = next!;
    if (aborted) return;
    for (const cb of headerCbs) cb({ header: res.header ?? {}, statusCode: res.statusCode });
    for (const chunk of res.chunks) {
      if (aborted) return;
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      for (const cb of chunkCbs) cb({ data });
    }
    if (aborted) return;
    options.success?.({ statusCode: res.statusCode, data: '' });
  }, 0);

  return {
    abort() {
      if (aborted) return;
      aborted = true;
      options.fail?.({ errMsg: 'request:fail abort' });
    },
    onHeadersReceived(cb: (res: { header: Record<string, string>; statusCode: number }) => void) {
      headerCbs.push(cb);
    },
    onChunkReceived(cb: (res: { data: ArrayBuffer }) => void) {
      chunkCbs.push(cb);
    },
  };
}

export function installMockUni() {
  state.storage.clear();
  state.requestQueue.length = 0;
  state.requestCalls.length = 0;
  state.requestError = null;
  state.uploadResult = null;
  state.uploadCalls.length = 0;
  state.chunkedQueue.length = 0;
  state.chunkedError = null;
  state.downloadResult = null;
  state.downloadError = null;
  state.downloadCalls.length = 0;
  state.toastCalls.length = 0;
  state.loadingCalls.length = 0;
  state.hideLoadingCount = 0;
  state.navigateCalls.length = 0;
  state.actionSheetChoice = null;
  state.actionSheetCalls.length = 0;
  state.chooseImageResult = null;
  state.chooseImageCalls.length = 0;
  state.loginResult = null;
  state.loginError = null;
  state.loginCalls.length = 0;
  state.modalCalls.length = 0;

  const uniMock = {
    getStorageSync: (key: string) => state.storage.get(key) ?? '',
    setStorageSync: (key: string, value: string) => void state.storage.set(key, value),
    removeStorageSync: (key: string) => void state.storage.delete(key),
    request: (options: {
      url: string;
      method?: string;
      header?: Record<string, string>;
      data?: unknown;
      timeout?: number;
      enableChunked?: boolean;
      success?: (res: { statusCode: number; data: unknown }) => void;
      fail?: (err: { errMsg: string }) => void;
    }) => {
      state.requestCalls.push({
        url: options.url,
        method: options.method ?? 'GET',
        header: options.header ?? {},
        data: options.data,
        timeout: options.timeout,
      });
      if (options.enableChunked) return makeChunkedTask(options);
      if (state.requestError) {
        options.fail?.(state.requestError);
        return;
      }
      const next = state.requestQueue.shift();
      if (!next) throw new Error('[mock-uni] request 队列为空，用例需先 enqueueResponse');
      options.success?.(next);
      return undefined;
    },
    uploadFile: (options: {
      url: string;
      filePath: string;
      name: string;
      header?: Record<string, string>;
      success?: (res: { statusCode: number; data: string }) => void;
      fail?: (err: { errMsg: string }) => void;
    }) => {
      state.uploadCalls.push({
        url: options.url,
        filePath: options.filePath,
        name: options.name,
        header: options.header ?? {},
      });
      if (state.requestError) {
        options.fail?.(state.requestError);
        return;
      }
      if (!state.uploadResult) throw new Error('[mock-uni] 未设置 uploadResult');
      options.success?.(state.uploadResult);
    },
    getSystemInfoSync: () => ({ theme: 'light' }),
    downloadFile: (options: {
      url: string;
      success?: (res: { statusCode: number; tempFilePath: string }) => void;
      fail?: (err: { errMsg: string }) => void;
      complete?: () => void;
    }) => {
      state.downloadCalls.push({ url: options.url });
      if (state.downloadError) {
        options.fail?.(state.downloadError);
      } else {
        if (!state.downloadResult) throw new Error('[mock-uni] 未设置 downloadResult');
        options.success?.(state.downloadResult);
      }
      options.complete?.();
    },
    showLoading: (options: { title: string }) => {
      state.loadingCalls.push({ title: options.title });
    },
    hideLoading: () => {
      state.hideLoadingCount += 1;
    },
    showToast: (options: { title: string; icon?: string }) => {
      state.toastCalls.push({ title: options.title, icon: options.icon });
    },
    navigateTo: (options: { url: string }) => {
      state.navigateCalls.push(options.url);
    },
    switchTab: () => undefined,
    /** MP30：action sheet 点选注入（setActionSheetChoice 预设；null = 用户取消走 fail） */
    showActionSheet: (options: {
      itemList: string[];
      success?: (res: { tapIndex: number }) => void;
      fail?: (err: { errMsg: string }) => void;
    }) => {
      state.actionSheetCalls.push({ itemList: options.itemList });
      if (state.actionSheetChoice === null) {
        options.fail?.({ errMsg: 'showActionSheet:fail cancel' });
        return;
      }
      options.success?.({ tapIndex: state.actionSheetChoice });
    },
    /** MP30：选图结果注入（setChooseImageResult 预设；null = 用户取消走 fail） */
    chooseImage: (options: {
      count?: number;
      sizeType?: string[];
      sourceType?: string[];
      success?: (res: {
        tempFilePaths: string[];
        tempFiles: Array<{ path: string; size: number }>;
      }) => void;
      fail?: (err: { errMsg: string }) => void;
    }) => {
      state.chooseImageCalls.push({
        count: options.count,
        sizeType: options.sizeType,
        sourceType: options.sourceType,
      });
      if (!state.chooseImageResult) {
        options.fail?.({ errMsg: 'chooseImage:fail cancel' });
        return;
      }
      options.success?.(state.chooseImageResult);
    },
    /** MP31：微信登录取 code（setLoginResult 预设 code；setLoginError 走 fail） */
    login: (options: {
      provider?: string;
      success?: (res: { code: string }) => void;
      fail?: (err: { errMsg: string }) => void;
    }) => {
      state.loginCalls.push({ provider: options.provider });
      if (state.loginError) {
        options.fail?.(state.loginError);
        return;
      }
      if (!state.loginResult) throw new Error('[mock-uni] 未设置 loginResult');
      options.success?.(state.loginResult);
    },
    /** MP31：modal 调用捕获（默认用户点确认） */
    showModal: (options: {
      title?: string;
      content?: string;
      showCancel?: boolean;
      success?: (res: { confirm: boolean; cancel: boolean }) => void;
    }) => {
      state.modalCalls.push({
        title: options.title,
        content: options.content,
        showCancel: options.showCancel,
      });
      options.success?.({ confirm: true, cancel: false });
    },
  };

  (globalThis as Record<string, unknown>).uni = uniMock;
  return uniMock;
}

/** 让下一次 uni.request 返回指定响应 */
export function enqueueResponse(statusCode: number, data: unknown) {
  state.requestQueue.push({ statusCode, data });
}

/** 让下一次 enableChunked 流式请求按序推送 chunks（字符串自动 UTF-8 编码） */
export function enqueueChunkedResponse(res: MockChunkedResponse) {
  state.chunkedQueue.push(res);
}

/** 让 enableChunked 流式请求直接走 fail */
export function setChunkedError(errMsg: string | null) {
  state.chunkedError = errMsg ? { errMsg } : null;
}

/** 让 uni.request 直接走 fail */
export function setRequestError(errMsg: string | null) {
  state.requestError = errMsg ? { errMsg } : null;
}

export function setUploadResult(statusCode: number, data: unknown) {
  state.uploadResult = { statusCode, data: JSON.stringify(data) };
}

export function lastRequest(): MockRequestCall {
  const call = state.requestCalls[state.requestCalls.length - 1];
  if (!call) throw new Error('[mock-uni] 尚无 request 调用');
  return call;
}

export function lastUpload() {
  const call = state.uploadCalls[state.uploadCalls.length - 1];
  if (!call) throw new Error('[mock-uni] 尚无 upload 调用');
  return call;
}

export function requestCallCount(): number {
  return state.requestCalls.length;
}

/** 全量 uploadFile 调用数（MP30：恢复附图不重复上传断言） */
export function uploadCallCount(): number {
  return state.uploadCalls.length;
}

/** 全量 request 调用记录（按发起顺序，流式/普通混合） */
export function allRequests(): MockRequestCall[] {
  return [...state.requestCalls];
}

/** 让下一次 uni.downloadFile 返回指定临时文件（MP28） */
export function setDownloadResult(statusCode: number, tempFilePath: string) {
  state.downloadResult = { statusCode, tempFilePath };
}

/** 让 uni.downloadFile 直接走 fail（MP28） */
export function setDownloadError(errMsg: string | null) {
  state.downloadError = errMsg ? { errMsg } : null;
}

export function allDownloads(): Array<{ url: string }> {
  return [...state.downloadCalls];
}

export function allToasts(): Array<{ title: string; icon?: string }> {
  return [...state.toastCalls];
}

export function lastToast(): { title: string; icon?: string } {
  const call = state.toastCalls[state.toastCalls.length - 1];
  if (!call) throw new Error('[mock-uni] 尚无 showToast 调用');
  return call;
}

export function allLoadings(): Array<{ title: string }> {
  return [...state.loadingCalls];
}

export function hideLoadingCount(): number {
  return state.hideLoadingCount;
}

export function allNavigations(): string[] {
  return [...state.navigateCalls];
}

/** 预设 action sheet 点选项（MP30；null = 用户取消走 fail） */
export function setActionSheetChoice(tapIndex: number | null) {
  state.actionSheetChoice = tapIndex;
}

export function lastActionSheet(): { itemList: string[] } {
  const call = state.actionSheetCalls[state.actionSheetCalls.length - 1];
  if (!call) throw new Error('[mock-uni] 尚无 showActionSheet 调用');
  return call;
}

/** 预设 chooseImage 返回（MP30；null = 用户取消走 fail） */
export function setChooseImageResult(filePath: string | null, size = 1024) {
  state.chooseImageResult = filePath
    ? { tempFilePaths: [filePath], tempFiles: [{ path: filePath, size }] }
    : null;
}

export function lastChooseImage(): { count?: number; sizeType?: string[]; sourceType?: string[] } {
  const call = state.chooseImageCalls[state.chooseImageCalls.length - 1];
  if (!call) throw new Error('[mock-uni] 尚无 chooseImage 调用');
  return call;
}

/** 预设 uni.login 成功返回的 code（MP31；空串模拟「响应缺 code」异常态） */
export function setLoginResult(code: string | null) {
  state.loginResult = code === null ? null : { code };
}

/** 让 uni.login 直接走 fail（MP31） */
export function setLoginError(errMsg: string | null) {
  state.loginError = errMsg ? { errMsg } : null;
}

/** 全量 uni.login 调用记录（MP31：provider 断言） */
export function allLoginCalls(): Array<{ provider?: string }> {
  return [...state.loginCalls];
}

/** 全量 showModal 调用记录（MP31：降级提示文案断言） */
export function allModals(): Array<{ title?: string; content?: string; showCancel?: boolean }> {
  return [...state.modalCalls];
}
