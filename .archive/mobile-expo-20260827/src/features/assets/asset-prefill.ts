/**
 * 产物 → 资产 预填参数（M28 作品库↔资产库联动）
 * - expo-router params 只支持字符串：prefill = encodeURIComponent(JSON.stringify(...))
 * - parse 侧防御：任何畸形输入静默返回 null，编辑屏按无预填处理
 */

/** 预填图：uploadImage 句柄 + 产物 mediaUrl 预览（资产未创建前 assetImageUrl 不可用） */
export interface AssetPrefillImage {
  filename: string;
  worker: string;
  preview: string;
}

export interface AssetPrefill {
  images: AssetPrefillImage[];
  name: string;
  nsfw: boolean;
}

/** 建议名上限：prompt 去空白后前 12 字 */
const SUGGEST_NAME_LEN = 12;
const SUGGEST_NAME_FALLBACK = '作品资产';

/** 建议名：prompt 去全部空白后取前 12 字（Array.from 按码点切，防代理对截断），空则兜底 */
export function suggestAssetName(prompt: string | null | undefined): string {
  const compact = (prompt ?? '').replace(/\s+/g, '');
  if (!compact) return SUGGEST_NAME_FALLBACK;
  return Array.from(compact).slice(0, SUGGEST_NAME_LEN).join('');
}

export interface BuildAssetPrefillInput {
  /** uploadImage 返回句柄 */
  filename: string;
  worker: string;
  /** 产物预览 URL（mediaUrl 已拼 token） */
  preview: string;
  /** 作业 prompt（建议名来源，空走兜底） */
  prompt?: string | null;
  nsfw: boolean;
}

/** 编码预填参数（单图：每张 image 产物各自独立「存为资产」） */
export function buildAssetPrefillParam(input: BuildAssetPrefillInput): string {
  const prefill: AssetPrefill = {
    images: [{ filename: input.filename, worker: input.worker, preview: input.preview }],
    name: suggestAssetName(input.prompt),
    nsfw: input.nsfw,
  };
  return encodeURIComponent(JSON.stringify(prefill));
}

/** 解码预填参数；畸形/缺关键字段（images 非空且每张带 filename+worker）返回 null */
export function parseAssetPrefill(param: string | null | undefined): AssetPrefill | null {
  if (!param) return null;
  try {
    const raw: unknown = JSON.parse(decodeURIComponent(param));
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.images) || obj.images.length === 0) return null;
    const images: AssetPrefillImage[] = [];
    for (const item of obj.images) {
      if (typeof item !== 'object' || item === null) return null;
      const img = item as Record<string, unknown>;
      if (typeof img.filename !== 'string' || !img.filename) return null;
      if (typeof img.worker !== 'string' || !img.worker) return null;
      images.push({
        filename: img.filename,
        worker: img.worker,
        preview: typeof img.preview === 'string' ? img.preview : '',
      });
    }
    return {
      images,
      name: typeof obj.name === 'string' ? obj.name : '',
      nsfw: obj.nsfw === true,
    };
  } catch {
    return null;
  }
}
