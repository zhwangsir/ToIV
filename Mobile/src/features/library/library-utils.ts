/**
 * 作品库过滤与标签工具（对齐 Web LibraryView 映射，移动端仅保留核心 kind）
 */

export type FilterKey = 'all' | 'image' | 'video' | 'audio' | '3d';

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
      'ltx_t2v',
      'ltx_i2v',
      'ltx_lipsync',
      'ltx2_t2v',
      'ltx2_i2v',
      'frame_interpolate',
      'dub_lipsync_long',
      'manju_lipsync',
      'anime_lipsync',
      'longcat_t2v',
      'longcat_i2v',
      'longcat_continue',
      'avatar_talk',
    ],
  },
  {
    key: 'audio',
    label: '音频',
    kinds: ['audio', 'ace_audio', 'audio_sep', 'transcribe', 'voice_track'],
  },
  { key: '3d', label: '3D', kinds: ['3d', 'model3d', 'hunyuan3d'] },
];

/** kind → 筛选桶；未识别返回 null，只在「全部」出现 */
export function kindToFilter(kind: string): FilterKey | null {
  for (const f of FILTERS) {
    if (f.kinds.includes(kind)) return f.key;
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
    ltx_t2v: '文生视频',
    ltx_i2v: '图生视频',
    ltx_lipsync: '对口型',
    ltx2_t2v: '文生视频',
    ltx2_i2v: '图生视频',
    frame_interpolate: '补帧',
    dub_lipsync_long: '长对口型',
    manju_lipsync: '对口型',
    anime_lipsync: '动漫对口型',
    longcat_t2v: '长视频',
    longcat_i2v: '长视频',
    longcat_continue: '长视频续写',
    avatar_talk: '数字人',
    audio: '音频',
    ace_audio: '音乐',
    audio_sep: '人声分离',
    transcribe: '听写',
    voice_track: '配音轨',
    '3d': '3D',
    model3d: '3D',
    hunyuan3d: '图生3D',
  };
  return map[kind] ?? '其他';
}
