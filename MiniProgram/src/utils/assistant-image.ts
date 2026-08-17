/**
 * 对话助手附图纯函数（MP30）
 * - 单图状态机：attach（替换语义）→ uploading → ready / fail（失败清 chip，toast 由页面层补）
 * - 上行组装：ready → ChatRequest.image={filename,worker}；uploading/空 → null（不带字段）
 * - 草稿持久化：仅 ready 句柄（filename/worker/previewUri）随会话键落盘，恢复直接用不重复上传
 * - 选图封装：showActionSheet（拍照/相册）+ chooseImage 全端三件套
 *   （uni.chooseMedia 仅微信小程序系实现，uni-h5 未导出——MP17 既有教训，此处同律）
 */
import type { AgentChatImage } from '@/types/api';

/** 输入栏图片 chip 状态（单图；后端 ChatRequest.image 契约仅一张） */
export interface AttachedImage {
  /** 本地临时文件预览地址（chooseImage tempFilePath；H5 为 blob: URL） */
  previewUri: string;
  status: 'uploading' | 'ready';
  /** 上传成功后的服务端句柄（uploading 态为空串） */
  filename: string;
  worker: string;
}

/** attach：进入 uploading 态；已有 chip（含 ready）再选 = 替换（不确认，行为以测试钉死） */
export function attachImageState(previewUri: string): AttachedImage {
  return { previewUri, status: 'uploading', filename: '', worker: '' };
}

/**
 * 上传成功回调：uploading → ready 落句柄
 * 竞态护栏：previewUri 不匹配（用户已替换/移除）或已非 uploading 的迟到回调原样返回不改写
 */
export function readyImageState(
  prev: AttachedImage | null,
  previewUri: string,
  handle: AgentChatImage,
): AttachedImage | null {
  if (!prev || prev.status !== 'uploading' || prev.previewUri !== previewUri) return prev;
  return { previewUri, status: 'ready', filename: handle.filename, worker: handle.worker };
}

/** 上传失败回调：清 chip（页面 toast 反馈）；不匹配的迟到失败不动现 chip */
export function failImageState(
  prev: AttachedImage | null,
  previewUri: string,
): AttachedImage | null {
  if (!prev || prev.previewUri !== previewUri) return prev;
  return null;
}

/** 发送门：上传中禁发（页面 canSend 与 store.send 同律，行为以测试钉死） */
export function canSendWithImage(state: AttachedImage | null): boolean {
  return state?.status !== 'uploading';
}

/** 上行组装：ready → image 字段；其余 → null（请求体不带 image 字段） */
export function buildChatImage(state: AttachedImage | null): AgentChatImage | null {
  if (!state || state.status !== 'ready') return null;
  return { filename: state.filename, worker: state.worker };
}

/** 草稿序列化：仅 ready 句柄可落盘（uploading 是瞬态，tempFile 失效无恢复价值） */
export function serializeImageDraft(state: AttachedImage | null): string | null {
  if (!state || state.status !== 'ready') return null;
  return JSON.stringify({
    filename: state.filename,
    worker: state.worker,
    previewUri: state.previewUri,
  });
}

/** 草稿解析（防御：畸形 JSON / 非对象 / 缺句柄字段 → null），恢复即 ready 不重复上传 */
export function parseImageDraft(raw: string): AttachedImage | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const d = data as Record<string, unknown>;
    if (typeof d.filename !== 'string' || d.filename === '') return null;
    if (typeof d.worker !== 'string' || d.worker === '') return null;
    if (typeof d.previewUri !== 'string' || d.previewUri === '') return null;
    return { previewUri: d.previewUri, status: 'ready', filename: d.filename, worker: d.worker };
  } catch {
    return null;
  }
}

/**
 * 选图：showActionSheet（拍照/相册）→ chooseImage（count 1，压缩图）
 * 任一环节用户取消 → null（不提示）；跨端禁用 uni.chooseMedia（H5 未实现）
 */
export function chooseAssistantImage(): Promise<string | null> {
  return new Promise((resolve) => {
    uni.showActionSheet({
      itemList: ['拍照', '相册'],
      success: ({ tapIndex }) => {
        if (tapIndex !== 0 && tapIndex !== 1) {
          resolve(null);
          return;
        }
        uni.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: [tapIndex === 0 ? 'camera' : 'album'],
          success: (res) => resolve(res.tempFilePaths[0] ?? null),
          fail: () => resolve(null),
        });
      },
      fail: () => resolve(null),
    });
  });
}
