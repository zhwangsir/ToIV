/**
 * 对话助手附图纯函数层（M30）：用户上传图片随消息发送
 * - 状态机：startUpload（选图即传，已有 chip 再选 = 替换覆盖）→ applyReady（落 /api/upload 句柄）；
 *   上传失败由 UI 层置 null + 人话（最小实现：chip 移除，非错误态重试）
 * - chipFor：chip 展示模型（上传中 loading 无移除钮；ready 缩略图 + X）
 * - imageForRequest：请求体组装（仅 ready 带 {filename,worker}，对齐后端单 image 契约）
 * - 持久化：ready 句柄随草稿按会话隔离（键挂 assistant_draft: 前缀下 :image 后缀），
 *   uploading 瞬态不落盘；恢复即完成态，不重复上传
 */
import { storage } from '@/lib/mmkv';
import type { AgentChatImage } from '@/types/api';

import { draftKeyFor } from './draft-utils';

/** 附图状态（uploading 瞬态不持久化；ready 句柄可随 draft 落盘恢复） */
export interface ChatAttachment {
  status: 'uploading' | 'ready';
  /** 本地预览（picker asset.uri；chip/气泡缩略图数据源） */
  previewUri: string;
  /** 展示名（picker 文件名，缺省 upload.<ext>） */
  name: string;
  /** ready：/api/upload 句柄（ChatRequest.image 契约入参） */
  filename?: string;
  worker?: string;
}

/** picker 选中资产的必要子集（expo-image-picker ImagePickerAsset） */
export interface PickedImage {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
  fileSize?: number;
}

/** 与后端 upload.py 一致的图片上限 */
export const CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 客户端扩展名白名单（后端 _EXT_TO_KIND 图片侧子集；gif 不收，与 ref-image-field 同源） */
const IMAGE_EXT_OK = new Set(['jpg', 'jpeg', 'png', 'webp']);
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** 扩展名推断：fileName 优先，缺省按 mimeType；识别不出返回 ''（交给白名单拦截） */
function extOf(fileName: string | null | undefined, mimeType: string | undefined): string {
  const fromName = fileName?.split('.').pop()?.toLowerCase() ?? '';
  if (fromName && fromName !== fileName?.toLowerCase()) return fromName;
  return MIME_TO_EXT[mimeType ?? ''] ?? '';
}

/** 选图即传：进入上传中（replace 语义——调用方直接以返回值覆盖旧 chip） */
export function startUpload(previewUri: string, name: string): ChatAttachment {
  return { status: 'uploading', previewUri, name };
}

/** 上传成功 → ready 句柄（预览/展示名继承上传中态） */
export function applyReady(att: ChatAttachment, handle: AgentChatImage): ChatAttachment {
  return {
    status: 'ready',
    previewUri: att.previewUri,
    name: att.name,
    filename: handle.filename,
    worker: handle.worker,
  };
}

/** chip 展示模型（上传中无移除钮——规避取消竞态；ready 可 X 移除） */
export interface AttachmentChipModel {
  uploading: boolean;
  previewUri: string;
  label: string;
}

export function chipFor(att: ChatAttachment | null): AttachmentChipModel | null {
  if (!att) return null;
  return { uploading: att.status === 'uploading', previewUri: att.previewUri, label: att.name };
}

/** 上传中（发送键禁用语义：句柄未就绪发送会丢图） */
export function attachmentBusy(att: ChatAttachment | null): boolean {
  return att?.status === 'uploading';
}

/** 请求体组装：仅 ready 带 {filename,worker}（后端单 image 契约，可与 document_ids 同发） */
export function imageForRequest(att: ChatAttachment | null): AgentChatImage | undefined {
  if (att?.status !== 'ready' || !att.filename || !att.worker) return undefined;
  return { filename: att.filename, worker: att.worker };
}

/** 选图客户端先验（与 upload.py 三重白名单同源；通过返回 null，否则人话） */
export function validatePickedImage(asset: PickedImage): string | null {
  if (!IMAGE_EXT_OK.has(extOf(asset.fileName, asset.mimeType))) {
    return '仅支持 jpg / png / webp 图片';
  }
  if (asset.fileSize !== undefined && asset.fileSize > CHAT_IMAGE_MAX_BYTES) {
    return '图片超过 20MB 上限';
  }
  return null;
}

/** 展示名：fileName 优先，缺省 upload.<ext>（mime 推断，识别不出回落 jpg） */
export function pickedImageName(asset: PickedImage): string {
  return asset.fileName?.trim() || `upload.${extOf(asset.fileName, asset.mimeType) || 'jpg'}`;
}

/** 持久化键：挂 assistant_draft: 前缀下（随输入草稿同前缀按会话隔离） */
export function attachmentKeyFor(sessionId: string | undefined): string {
  return `${draftKeyFor(sessionId)}:image`;
}

/** 序列化：仅 ready 句柄可落盘（uploading 瞬态/空态返回 null） */
export function serializeAttachment(att: ChatAttachment | null): string | null {
  if (att?.status !== 'ready' || !att.filename || !att.worker) return null;
  return JSON.stringify({
    filename: att.filename,
    worker: att.worker,
    previewUri: att.previewUri,
    name: att.name,
  });
}

/** 反序列化：畸形/缺字段一律 null；恢复即 ready 完成态（不重复上传） */
export function parseAttachment(raw: string | undefined | null): ChatAttachment | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as {
      filename?: unknown;
      worker?: unknown;
      previewUri?: unknown;
      name?: unknown;
    };
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    if (typeof data.filename !== 'string' || !data.filename) return null;
    if (typeof data.worker !== 'string' || !data.worker) return null;
    if (typeof data.previewUri !== 'string' || !data.previewUri) return null;
    return {
      status: 'ready',
      filename: data.filename,
      worker: data.worker,
      previewUri: data.previewUri,
      name: typeof data.name === 'string' && data.name ? data.name : data.filename,
    };
  } catch {
    return null;
  }
}

export function loadAttachment(sessionId: string | undefined): ChatAttachment | null {
  return parseAttachment(storage.getString(attachmentKeyFor(sessionId)));
}

/** 写入；null/非 ready 等价清除（不留空占位键，与 saveDraft 空串语义一致） */
export function saveAttachment(sessionId: string | undefined, att: ChatAttachment | null): void {
  const key = attachmentKeyFor(sessionId);
  const raw = serializeAttachment(att);
  if (raw) storage.set(key, raw);
  else storage.remove(key);
}

export function clearAttachment(sessionId: string | undefined): void {
  storage.remove(attachmentKeyFor(sessionId));
}
