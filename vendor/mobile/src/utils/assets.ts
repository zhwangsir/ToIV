/**
 * 参考资产库纯逻辑（MP13）：kind 字典 / 过滤 / 表单先验 / 编辑差量 / 创作页追加拦截
 * 与 UI 解耦，vitest 直接覆盖（对齐 utils/library.ts 模式）
 */
import type { AssetImage, AssetItem, AssetKind, AssetPatchBody } from '@/types/api';

/** 资产类别字典（角色/场景/道具/风格，与后端 AssetKind 一一对应） */
export const ASSET_KINDS: readonly { key: AssetKind; label: string }[] = [
  { key: 'character', label: '角色' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '道具' },
  { key: 'style', label: '风格' },
];

export function assetKindLabel(kind: string): string {
  return ASSET_KINDS.find((k) => k.key === kind)?.label ?? kind;
}

/** 后端硬约束：images 1-4 张（≤4 是质量拐点）、name 1-100 字符 */
export const ASSET_IMAGES_MAX = 4;
export const ASSET_NAME_MAX = 100;
export const ASSET_DESCRIPTION_MAX = 2000;

/** 列表 kind 过滤（'all' 不过滤；本地过滤，一次拉全量避免 chips 切换反复请求） */
export function filterAssetsByKind(assets: AssetItem[], kind: AssetKind | 'all'): AssetItem[] {
  if (kind === 'all') return assets;
  return assets.filter((a) => a.kind === kind);
}

/** 资产表单草稿（编辑态由 assetToDraft 回显映射） */
export interface AssetDraft {
  kind: AssetKind;
  name: string;
  description: string;
  nsfw: boolean;
  images: AssetImage[];
}

/** 编辑回显：AssetItem → 表单草稿（图片句柄原样保留，不重新上传） */
export function assetToDraft(asset: AssetItem): AssetDraft {
  return {
    kind: asset.kind,
    name: asset.name,
    description: asset.description,
    nsfw: asset.nsfw,
    images: asset.images.map((img) => ({ filename: img.filename, worker: img.worker })),
  };
}

/**
 * 提交前本地先验：名称 trim 非空（长度边界由输入框 maxlength + 后端 422 双兜底）、图片 1-4 张
 * 返回人话错误串；空串 = 通过
 */
export function validateAssetDraft(draft: { name: string; images: unknown[] }): string {
  if (draft.name.trim().length === 0) return '请填写资产名称';
  if (draft.name.trim().length > ASSET_NAME_MAX) return `名称不能超过 ${ASSET_NAME_MAX} 字`;
  if (draft.images.length === 0) return '请至少上传 1 张参考图';
  if (draft.images.length > ASSET_IMAGES_MAX) return `参考图最多 ${ASSET_IMAGES_MAX} 张`;
  return '';
}

function sameImages(a: AssetImage[], b: AssetImage[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((img, i) => img.filename === b[i].filename && img.worker === b[i].worker);
}

/** 编辑保存差量：仅变更字段进 patch（对齐后端 PATCH 仅非 null 生效）；无变更返回 {} */
export function buildAssetPatch(original: AssetItem, next: AssetDraft): AssetPatchBody {
  const patch: AssetPatchBody = {};
  const name = next.name.trim();
  const description = next.description.trim();
  if (name !== original.name) patch.name = name;
  if (description !== original.description) patch.description = description;
  if (next.kind !== original.kind) patch.kind = next.kind;
  if (next.nsfw !== original.nsfw) patch.nsfw = next.nsfw;
  if (!sameImages(original.images, next.images)) patch.images = next.images;
  return patch;
}

export type AssetAppendResult<T> =
  | { ok: true; images: T[] }
  | { ok: false; reason: 'limit' | 'worker' };

/**
 * 创作页多图字段从资产库追加句柄：
 * - 达上限拦截（wan-vace 1-4 张，与上传入口同一上限）
 * - 已选图存在时须同 worker（资产句柄已带落点，跨机混钉会破坏生成同机约束）
 */
export function appendAssetImage<T extends AssetImage>(
  current: T[],
  handle: T,
  max: number,
): AssetAppendResult<T> {
  if (current.length >= max) return { ok: false, reason: 'limit' };
  if (current.length > 0 && current[0].worker !== handle.worker) {
    return { ok: false, reason: 'worker' };
  }
  return { ok: true, images: [...current, handle] };
}
