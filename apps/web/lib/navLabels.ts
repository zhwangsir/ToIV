/**
 * Similar-merge P1 Slice B — ⌘K / SideRail / VIEW_META / MORE 文案对齐表（#13/#17/#25）。
 * 单源常量；page.tsx 与 CommandPalette 引用，避免三套导航漂移。
 * 不删入口、不改路由 key、不改 resolve / 引擎 id。
 */
export const NAV_LABELS = {
  studio: "做短剧",
  home: "智能体",
  library: "作品库",
  market: "工具箱",
  /** web Generate 下沉为工具箱·引擎台（canvas 为主创作面） */
  image: "工具箱·图片引擎",
  video: "工具箱·视频引擎",
  audio: "工具箱·音频",
  resources: "资源中心",
  entities: "主体库",
  animatic: "动态分镜",
  canvas: "画布",
  fusion: "融合",
  imageEdit: "图片编辑",
  videoEdit: "视频剪辑",
  avatartalk: "数字人",
  dub: "译制",
  settings: "设置",
  /** 窄屏 MORE 短签（语义同 NAV_LABELS.image/video，省略「工具箱·」前缀省宽） */
  imageMore: "图片引擎",
  videoMore: "视频引擎",
  audioMore: "音频",
  resourcesMore: "资源",
  libraryRail: "作品库",
} as const;

export type NavLabelKey = keyof typeof NAV_LABELS;
