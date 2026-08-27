/**
 * 媒体下载与保存工具（Web 平台存根）
 * - expo-media-library 无 web 实现：其包入口顶层 `class Asset extends ExpoMediaLibraryNext.Asset`
 *   在 web 静态渲染求值时原生模块为空壳，直接抛 TypeError 导致 expo export 失败；
 *   Metro 平台扩展（.web.ts）使 web 端只加载本文件，原生端仍走 media.ts
 * - 保存相册/下载缓存属原生能力，web 端调用统一抛人话 Error（调用方 catch 后 toast，契约与 media.ts 一致）
 */

/**
 * Web 端不支持下载远程文件到缓存目录。
 * @throws Error('Web 端不支持下载，请在 App 中操作')
 */
export async function downloadToCache(_url: string): Promise<string> {
  throw new Error('Web 端不支持下载，请在 App 中操作');
}

/**
 * Web 端不支持保存到系统相册。
 * @throws Error('Web 端不支持保存到相册，请在 App 中操作')
 */
export async function downloadAndSaveToLibrary(_url: string): Promise<void> {
  throw new Error('Web 端不支持保存到相册，请在 App 中操作');
}
