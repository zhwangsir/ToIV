/**
 * 对话助手媒体预览纯函数（MP24）
 * 气泡媒体产物点击预览的 URL 组解析；resolve 由调用方注入（api client mediaUrl），便于单测
 */

/** 结构最小集（与 stores/assistant ChatMedia 结构兼容），避免 utils 反向依赖 store 类型 */
export interface PreviewMediaLike {
  urls: string[];
}

/** 图片预览整组 URL（相对路径经 resolve 解析为可加载地址；顺序保持、空数组原样返回） */
export function previewUrls(media: PreviewMediaLike, resolve: (path: string) => string): string[] {
  return media.urls.map((u) => resolve(u));
}

/** 视频/音频首条产物 URL（无产物返回 null，UI 据此不出入口） */
export function firstPreviewUrl(
  media: PreviewMediaLike,
  resolve: (path: string) => string,
): string | null {
  const first = media.urls[0];
  return first ? resolve(first) : null;
}
