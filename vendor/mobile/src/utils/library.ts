/**
 * 作品库过滤/布局工具（移植自 Mobile features/library/library-utils.ts + library-screen.tsx，逐值对齐）
 * 纯逻辑独立成文件：vitest 直测，页面只做渲染
 * 分桶/短名与 apps/web/lib/libraryQuery.ts 对齐（Job.kind 下划线，非引擎 id）
 */
import type { JobItem } from '@/types/api';

export type FilterKey = 'all' | 'image' | 'video' | 'audio' | '3d';

/**
 * 作品库页大小（MP15）：列数断点 2/3/4 列，24 = 12×2 是三者公倍数——
 * 满页时任意断点恰好填满整行不留半行空洞；24 < 后端默认 50，首屏更轻
 */
export const LIBRARY_PAGE_SIZE = 24;

export interface FilterDef {
  key: FilterKey;
  label: string;
  kinds: string[];
}

export const FILTERS: FilterDef[] = [
  { key: 'all', label: '全部', kinds: [] },
  {
    key: 'image',
    label: '图像',
    kinds: [
      'txt2img',
      'img2img',
      'controlnet',
      'upscale',
      'facedetailer',
      'inpaint',
      'removebg',
      'raw',
      // Qwen-Image-Edit 语义编辑 / 3D 相机(360° 环绕序列成员 kind)
      'qwen_edit',
      // 短剧 studio 图像类产物
      'drama_grid_storyboard',
      'drama_scene_layout',
      // i2L 风格 LoRA(图像参考导出) / Motion Brush mask PNG
      'i2l',
      'motion_brush',
    ],
  },
  {
    key: 'video',
    label: '视频',
    kinds: [
      'video',
      'txt2video',
      'img2video',
      'lipsync',
      'kenburns',
      'wan_t2v',
      'wan_i2v',
      'hunyuan_i2v',
      'h3_t2v',
      'h3_i2v',
      // H3 多镜头单次生成(单段内切镜)
      'h3_multishot',
      // H3 超 15s 分段续写(末帧 i2v)
      'h3_extend_i2v',
      'ltx_t2v',
      'ltx_i2v',
      'ltx_lipsync',
      'ltx2_t2v',
      'ltx2_i2v',
      'frame_interpolate',
      'dub_lipsync_long',
      'manju_lipsync',
      'anime_lipsync',
      // 视频超分(M6 fleet 帧级 4K 管线)
      'video_upscale',
      'longcat_t2v',
      'longcat_i2v',
      'longcat_continue',
      'avatar_talk',
      // Wan2.1-VACE 首尾帧转场
      'transition',
      // VACE 视频到视频编辑
      'video_edit',
      // 关键帧链式转场(合并成片;段产物 kind=transition 已在上)
      'keyframe_chain',
      // 短剧 studio 视频类产物
      'drama_shot_video',
      'drama_shot_video_i2v',
      'drama_shot_video_v2',
      'drama_shot_lipsync',
      // 绿幕抠像 / Wan 动作迁移
      'chromakey',
      'wan_animate',
      'wan_animate2',
    ],
  },
  {
    key: 'audio',
    label: '音频',
    kinds: ['audio', 'ace_audio', 'audio_sep', 'transcribe', 'voice_track', 'manju_voice'],
  },
  { key: '3d', label: '3D', kinds: ['3d', 'model3d', 'hunyuan3d', 'threed_material', 'threed_render', 'threed_texture'] },
];

/** 动态前缀规则(后端按 preset/视角拼 kind):cad_* → 3D;drama_char_reference_* → 图像。 */
export const KIND_PREFIX_RULES: [string, FilterKey][] = [
  ['cad_', '3d'],
  ['drama_char_reference_', 'image'],
];

/**
 * 类型 chip → 后端 GET /api/jobs?kind= 多值(逗号分隔)；「全部」空串不过滤。
 * 前缀 token(以 _ 结尾,如 cad_ / drama_char_reference_)一并送给服务端:
 * GET /api/jobs 把这类 token 当 startswith,精确值仍 in_(...)。
 * 对齐 apps/web/lib/libraryQuery.ts kindsQueryForFilter。
 */
export function kindsQueryForFilter(filter: FilterKey): string {
  if (filter === 'all') return '';
  const f = FILTERS.find((x) => x.key === filter);
  const kinds = [...(f?.kinds ?? [])];
  for (const [prefix, key] of KIND_PREFIX_RULES) {
    if (key === filter && !kinds.includes(prefix)) kinds.push(prefix);
  }
  return kinds.length > 0 ? kinds.join(',') : '';
}

/** kind → 筛选桶；未识别返回 null，只在「全部」出现 */
export function kindToFilter(kind: string): FilterKey | null {
  for (const f of FILTERS) {
    if (f.kinds.includes(kind)) return f.key;
  }
  for (const [prefix, key] of KIND_PREFIX_RULES) {
    if (kind.startsWith(prefix)) return key;
  }
  return null;
}

/** 中文短标签；未知 kind 兜底「其他」 */
export function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    txt2img: '文生图',
    img2img: '图生图',
    controlnet: 'ControlNet',
    upscale: '放大',
    facedetailer: '脸部修复',
    inpaint: '局部重绘',
    removebg: '抠图',
    raw: '原图',
    qwen_edit: '智能编辑',
    video: '视频',
    txt2video: '文生视频',
    img2video: '图生视频',
    lipsync: '对口型',
    kenburns: '运镜',
    wan_t2v: '文生视频',
    wan_i2v: '图生视频',
    hunyuan_i2v: '图生视频',
    h3_t2v: '文生视频',
    h3_i2v: '图生视频',
    h3_multishot: '多镜头',
    h3_extend_i2v: '长视频续写',
    ltx_t2v: '文生视频',
    ltx_i2v: '图生视频',
    ltx_lipsync: '对口型',
    ltx2_t2v: '文生视频',
    ltx2_i2v: '图生视频',
    frame_interpolate: '补帧',
    video_upscale: '视频超分',
    dub_lipsync_long: '长对口型',
    manju_lipsync: '对口型',
    anime_lipsync: '动漫对口型',
    longcat_t2v: '长视频',
    longcat_i2v: '长视频',
    longcat_continue: '长视频续写',
    avatar_talk: '数字人',
    transition: '首尾帧转场',
    video_edit: '视频编辑',
    keyframe_chain: '关键帧链',
    audio: '音频',
    ace_audio: '音乐',
    audio_sep: '人声分离',
    transcribe: '听写',
    voice_track: '配音轨',
    manju_voice: '配音',
    '3d': '3D',
    model3d: '3D',
    hunyuan3d: '图生3D',
    threed_material: '3D 材质',
    threed_render: '3D 渲染',
    threed_texture: '3D 纹理',
    chromakey: '抠像',
    i2l: '风格LoRA',
    motion_brush: '局部动效',
    wan_animate: '动作迁移',
    wan_animate2: '动作迁移2',
    drama_grid_storyboard: '分镜',
    drama_scene_layout: '场景布局',
    drama_shot_video: '镜头视频',
    drama_shot_video_i2v: '镜头视频',
    drama_shot_video_v2: '镜头视频',
    drama_shot_lipsync: '镜头对口型',
  };
  if (map[kind]) return map[kind];
  if (kind.startsWith('cad_')) return 'CAD';
  if (kind.startsWith('drama_char_reference_')) return '角色参考';
  return '其他';
}

/** 作品库只收藏完成且有产物的作业 */
export function collectArtifacts(jobs: JobItem[] | undefined): JobItem[] {
  return (jobs ?? []).filter((j) => j.status === 'done' && j.results.length > 0);
}

/** 各过滤桶计数（all = 全量；未识别 kind 不计入任何子桶） */
export function countByFilter(artifacts: JobItem[]): Record<FilterKey, number> {
  const counts: Record<FilterKey, number> = { all: artifacts.length, image: 0, video: 0, audio: 0, '3d': 0 };
  for (const j of artifacts) {
    const key = kindToFilter(j.kind);
    if (key) counts[key] += 1;
  }
  return counts;
}

/** 断点 → 列数（指南 7.1：phone 2 列 / 大屏 3 列 / 平板 4 列） */
export function columnCount(windowWidthPx: number): number {
  if (windowWidthPx >= 768) return 4;
  if (windowWidthPx >= 431) return 3;
  return 2;
}

/** 网格卡边长（px）：屏宽减页面左右内边距与列间隙后均分 */
export function cardSizePx(
  windowWidthPx: number,
  columns: number,
  pagePaddingPx = 16,
  gapPx = 12,
): number {
  return (windowWidthPx - pagePaddingPx * 2 - gapPx * (columns - 1)) / columns;
}

/** 产物路径是否为视频（扩展名判断，与 job-card 一致） */
export function isVideoPath(path: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(path);
}
