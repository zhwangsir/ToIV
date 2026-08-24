/**
 * 统一媒体格式识别(2026-08-24):扩展名优先,kind 兜底。
 * 签名 URL 文件名常在查询串(/api/images?f=a.mp4&sig=…),扩展名匹配不剥查询。
 * 供作品库灯箱/网格、助手气泡、图像编辑结果卡共用;
 * AssistantView.mediaTypeForJob 已收敛为本函数的薄封装(参数顺序不同,勿再各自维护正则)。
 */
import { kindToFilter } from "./libraryQuery";

export type MediaKind = "image" | "video" | "audio" | "model3d";

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|&|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac)(\?|&|$)/i;
const MODEL3D_EXT = /\.(glb|gltf)(\?|&|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|&|$)/i;

/**
 * url/kind → 媒体渲染分支。
 * 扩展名能识别时以文件真实格式为准(防 glb 落进 <img> 裂图);
 * 无扩展名(签名 URL / 纯 id 路径)时回退 kind 映射;都识别不了按 image。
 */
export function mediaKindOf(url: string, kind = ""): MediaKind {
  const u = (url || "").toLowerCase();
  if (MODEL3D_EXT.test(u)) return "model3d";
  if (VIDEO_EXT.test(u)) return "video";
  if (AUDIO_EXT.test(u)) return "audio";
  if (IMAGE_EXT.test(u)) return "image";
  const f = kindToFilter(kind);
  if (f === "image" || f === "video" || f === "audio") return f;
  if (f === "3d") return "model3d";
  return "image";
}
