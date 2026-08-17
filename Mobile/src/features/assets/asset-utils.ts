/**
 * 参考资产库工具（M13，契约已读 apps/api 源码验证：routes/reference_assets.py）
 * - kind 注册表 / 表单先验 / 编辑态部分更新 diff 均为纯函数，供页面与测试复用
 */

import type { IconName } from '@/components/ui/Icon';
import type { AssetImage, AssetItem, AssetKind, AssetPatchBody } from '@/types/api';

/** 单资产参考图硬上限（后端 AssetCreate.images max_length=4：≤4 是参考一致性质量拐点） */
export const ASSET_IMAGE_MAX = 4;

/** 名称/描述边界（后端 Field min_length=1 max_length=100 / max_length=2000） */
export const ASSET_NAME_MAX = 100;
export const ASSET_DESCRIPTION_MAX = 2000;

/**
 * 资产图上传 kind：capabilities.py 对 img2img 无模型/节点门槛（return set()），
 * 落点任意可达 pool worker；引用时按句柄 worker 钉生成机（generate.py resolve_worker）
 */
export const ASSET_UPLOAD_KIND = 'img2img';

export interface AssetKindDef {
  key: AssetKind;
  label: string;
  icon: IconName;
}

/** 资产类别注册表：角色/场景/道具/风格卡（顺序对齐后端 AssetKind Literal 声明） */
export const ASSET_KINDS: readonly AssetKindDef[] = [
  { key: 'character', label: '角色', icon: 'UserRound' },
  { key: 'scene', label: '场景', icon: 'Image' },
  { key: 'prop', label: '道具', icon: 'Box' },
  { key: 'style', label: '风格', icon: 'Palette' },
];

/** 中文短标签；未知 kind 兜底「其他」（与 library-utils kindLabel 同语义） */
export function assetKindLabel(kind: string): string {
  return ASSET_KINDS.find((k) => k.key === kind)?.label ?? '其他';
}

export function assetKindIcon(kind: string): IconName {
  return ASSET_KINDS.find((k) => k.key === kind)?.icon ?? 'Layers';
}

// ── 选图先验（与 upload.py 三重白名单同源：扩展名 + ≤20MB，魔数由后端兜底 415）──

const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = new Set(['jpg', 'jpeg', 'png', 'webp']);
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** 扩展名推断：fileName 优先，缺省按 mimeType；识别不出返回 ''（交给白名单拦截） */
export function imageExtOf(fileName: string | null | undefined, mimeType: string | undefined): string {
  const fromName = fileName?.split('.').pop()?.toLowerCase() ?? '';
  if (fromName && fromName !== fileName?.toLowerCase()) return fromName;
  return MIME_TO_EXT[mimeType ?? ''] ?? '';
}

/** 单张待上传图先验：通过返回 null，否则返回人话错误（与 ref-image-field 判定同语义） */
export function validateImagePick(asset: {
  fileName?: string | null;
  mimeType?: string;
  fileSize?: number;
}): string | null {
  if (!IMAGE_EXT_OK.has(imageExtOf(asset.fileName, asset.mimeType))) {
    return '仅支持 jpg / png / webp 图片';
  }
  if (asset.fileSize !== undefined && asset.fileSize > IMAGE_MAX_BYTES) {
    return '图片超过 20MB 上限';
  }
  return null;
}

/** 表单先验：名称 1-100 字（trim 后）、图片 1-4 张；通过返回 null，否则返回人话错误 */
export function validateAssetDraft(draft: { name: string; images: unknown[] }): string | null {
  const name = draft.name.trim();
  if (!name) return '请填写资产名称';
  if (name.length > ASSET_NAME_MAX) return `名称不能超过 ${ASSET_NAME_MAX} 字`;
  if (draft.images.length === 0) return '请至少添加 1 张参考图';
  if (draft.images.length > ASSET_IMAGE_MAX) return `参考图最多 ${ASSET_IMAGE_MAX} 张`;
  return null;
}

/**
 * 编辑态部分更新：仅相对原资产变化的字段进 patch（对齐后端 AssetPatch 非 None 才落库）；
 * images 按 (filename, worker) 有序逐项比对，任一不同即整体替换
 */
export function buildAssetPatch(
  original: AssetItem,
  draft: {
    kind: AssetKind;
    name: string;
    description: string;
    images: AssetImage[];
    nsfw: boolean;
  },
): AssetPatchBody {
  const patch: AssetPatchBody = {};
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (draft.kind !== original.kind) patch.kind = draft.kind;
  if (name !== original.name) patch.name = name;
  if (description !== original.description) patch.description = description;
  if (draft.nsfw !== original.nsfw) patch.nsfw = draft.nsfw;
  const sameImages =
    draft.images.length === original.images.length &&
    draft.images.every(
      (img, i) =>
        img.filename === original.images[i].filename && img.worker === original.images[i].worker,
    );
  if (!sameImages) patch.images = draft.images;
  return patch;
}
