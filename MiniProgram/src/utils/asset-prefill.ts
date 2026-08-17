/**
 * 作品库↔资产库联动（MP28）：产物一键存为资产
 * 纯逻辑独立成文件：vitest 直测，页面只做渲染/事件接线
 * 链路：详情页 downloadFile 拉产物字节 → uploadImage 上传 pool worker →
 *       navigateTo 资产页 ?prefill=<encodeURIComponent(JSON)> → 资产页 onLoad 解析自动开新建弹层
 */
import { uploadImage } from '@/api';
import { mediaUrl } from '@/api/client';
import type { JobItem, UploadedRefImage, UploadImageResult } from '@/types/api';
import { isVideoPath, kindToFilter } from '@/utils/library';

/** 资产页路由（pages.json 主包页，非原生 tabBar，navigateTo 可达） */
export const ASSETS_PAGE_PATH = '/pages/assets/index';

export interface AssetPrefillImage {
  filename: string;
  worker: string;
  /** 预览 URL（产物 mediaUrl——资产未创建前 assetImageUrl 不可用） */
  preview: string;
}

export interface AssetPrefill {
  images: AssetPrefillImage[];
  name: string;
  nsfw: boolean;
}

/** 建议名：prompt 去空白取前 12 字（按码点切，防代理对截半），空兜底「作品资产」 */
export function suggestAssetName(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, '');
  if (!collapsed) return '作品资产';
  return Array.from(collapsed).slice(0, 12).join('');
}

/** 仅 image 类产物可存为资产（资产卡只收图片；video/audio/3D 不渲染入口）。index 越界钳到最后一张 */
export function canSaveArtifactAsAsset(job: JobItem | null, index: number): boolean {
  if (!job || job.results.length === 0) return false;
  if (kindToFilter(job.kind) !== 'image') return false;
  const path = job.results[Math.min(index, job.results.length - 1)];
  return path !== '' && !isVideoPath(path);
}

/** 产物 + 上传句柄 → prefill query 值（encodeURIComponent(JSON)，直接拼 ?prefill= 后） */
export function buildAssetPrefillQuery(
  input: { path: string; prompt: string; nsfw: boolean; upload: UploadImageResult },
  resolveUrl: (path: string) => string,
): string {
  const prefill: AssetPrefill = {
    images: [
      {
        filename: input.upload.filename,
        worker: input.upload.worker,
        preview: resolveUrl(input.path),
      },
    ],
    name: suggestAssetName(input.prompt),
    nsfw: input.nsfw,
  };
  return encodeURIComponent(JSON.stringify(prefill));
}

/**
 * prefill query 解析（防御：畸形 JSON/缺字段一律 null，调用方静默忽略）
 * 兼容已编码（未 decode）与已解码（uni onLoad query 自动解码）两种输入
 */
export function parseAssetPrefill(raw: string | undefined | null): AssetPrefill | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.images)) return null;
  const images: AssetPrefillImage[] = [];
  for (const item of obj.images) {
    if (!item || typeof item !== 'object') continue;
    const img = item as Record<string, unknown>;
    if (typeof img.filename !== 'string' || img.filename === '') continue;
    if (typeof img.worker !== 'string' || img.worker === '') continue;
    images.push({
      filename: img.filename,
      worker: img.worker,
      preview: typeof img.preview === 'string' ? img.preview : '',
    });
  }
  if (images.length === 0) return null;
  return {
    images,
    name: typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name : '作品资产',
    nsfw: obj.nsfw === true,
  };
}

/** prefill → 新建弹层表单初值（previewUri 用产物 mediaUrl，name 用 filename 兜底） */
export function assetPrefillToForm(prefill: AssetPrefill): {
  name: string;
  nsfw: boolean;
  images: UploadedRefImage[];
} {
  return {
    name: prefill.name,
    nsfw: prefill.nsfw,
    images: prefill.images.map((img) => ({
      filename: img.filename,
      worker: img.worker,
      previewUri: img.preview,
      name: img.filename,
    })),
  };
}

/** 下载产物字节到本地临时文件（对齐详情页「下载到相册」downloadFile 模式） */
function downloadArtifact(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    uni.downloadFile({
      url,
      success: (dl) => {
        if (dl.statusCode === 200) resolve(dl.tempFilePath);
        else reject(new Error('下载失败，请重试'));
      },
      fail: () => reject(new Error('下载失败，请检查网络')),
    });
  });
}

/**
 * 存为资产主流程：下载产物 → 上传 pool worker（kind=img2img）→ 携 prefill 跳资产页
 * 任一步失败 toast 人话停留原页；成功返回 true（页面侧 acting 守卫自管，测试断言用）
 * upload 可注入（测试隔离）；默认 uploadImage kind=img2img
 */
export async function saveArtifactAsAsset(
  input: { path: string; prompt: string; nsfw: boolean },
  upload: (filePath: string) => Promise<UploadImageResult> = (fp) => uploadImage(fp, 'img2img'),
): Promise<boolean> {
  uni.showLoading({ title: '准备中…', mask: true });
  try {
    const tempFilePath = await downloadArtifact(mediaUrl(input.path));
    const uploaded = await upload(tempFilePath);
    uni.hideLoading();
    const query = buildAssetPrefillQuery({ ...input, upload: uploaded }, mediaUrl);
    uni.navigateTo({ url: `${ASSETS_PAGE_PATH}?prefill=${query}` });
    return true;
  } catch (err) {
    uni.hideLoading();
    uni.showToast({
      title: err instanceof Error ? err.message : '上传失败，请重试',
      icon: 'none',
    });
    return false;
  }
}
