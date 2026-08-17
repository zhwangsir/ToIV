/**
 * 媒体下载与保存工具
 * - 用 expo-file-system 下载到 cache
 * - 用 expo-media-library Asset.create 保存到相册
 * - 失败时抛人话 Error，调用方 catch 后 toast
 */

import { File, Paths } from 'expo-file-system';
import { Asset, requestPermissionsAsync } from 'expo-media-library';

/**
 * 下载远程文件到缓存目录，返回本地 file URI（M28：产物存为资产的上传源）。
 * @param url 产物完整 URL（已由 mediaUrl 拼接 token）
 * @throws Error('下载失败，请检查网络')
 */
export async function downloadToCache(url: string): Promise<string> {
  // 剥 query（mediaUrl 会拼 ?token=），取纯文件名
  const fileName =
    url
      .split('?')[0]
      .split('/')
      .filter(Boolean)
      .pop() || `toiv_${Date.now()}.png`;
  const cacheFile = new File(Paths.cache, fileName);

  try {
    await File.downloadFileAsync(url, cacheFile);
  } catch {
    throw new Error('下载失败，请检查网络');
  }

  return cacheFile.uri;
}

/**
 * 下载远程文件并保存到系统相册。
 * @param url 产物完整 URL（已由 mediaUrl 拼接 token）
 * @throws Error('需要相册权限...') | Error('下载失败...')
 */
export async function downloadAndSaveToLibrary(url: string): Promise<void> {
  const uri = await downloadToCache(url);

  const { status } = await requestPermissionsAsync(true, []);
  if (status !== 'granted') {
    throw new Error('需要相册权限以保存作品');
  }

  await Asset.create(uri);
}
