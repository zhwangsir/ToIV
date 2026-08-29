/**
 * 作品库查询纯逻辑(2026-08-15 作品库重设计拆出):
 * 类型筛选(FILTERS/KIND_PREFIX_RULES)、内容分级、prompt 搜索、时间排序
 * 全部收敛为 applyLibraryQuery 单一入口,组件侧只负责 state 与渲染;
 * 密度切换(舒适/紧凑)与批量删除流同为纯函数/小 helper,便于 node:test 直测。
 */
import type { JobItem } from "./types";

export type FilterKey = "all" | "image" | "video" | "audio" | "3d";

/** 内容维度过滤(M9):SFW = 非 nsfw 作品,R18 = nsfw 作品;R18 chip 仅 R18 模式渲染。 */
export type ContentFilterKey = "all" | "sfw" | "r18";

/** 排序:按 created_at 最新/最早。 */
export type SortKey = "newest" | "oldest";

/** 网格密度:舒适(更大卡)/ 紧凑(更小卡 + 更小字号),localStorage 记忆。 */
export type LibraryDensity = "comfortable" | "compact";

export interface FilterDef {
  key: FilterKey;
  label: string;
  kinds: string[];
}

export const FILTERS: FilterDef[] = [
  { key: "all", label: "全部", kinds: [] },
  {
    key: "image",
    label: "图像",
    kinds: [
      "txt2img", "img2img", "controlnet", "upscale", "facedetailer",
      "inpaint", "removebg", "raw",
      // Qwen-Image-Edit 语义编辑 / 3D 相机(360° 环绕序列成员 kind)
      "qwen_edit",
      // 短剧 studio 图像类产物
      "drama_grid_storyboard", "drama_scene_layout",
      // i2L 风格 LoRA(图像参考导出) / Motion Brush mask PNG
      "i2l", "motion_brush",
    ],
  },
  {
    key: "video",
    label: "视频",
    kinds: [
      "video", "txt2video", "img2video", "lipsync", "kenburns",
      "wan_t2v", "wan_i2v", "hunyuan_i2v", "h3_t2v", "h3_i2v",
      // H3 多镜头单次生成(单段内切镜)
      "h3_multishot",
      // H3 超 15s 分段续写(末帧 i2v,kind=h3_extend_i2v)
      "h3_extend_i2v",
      "ltx_t2v", "ltx_i2v", "ltx_lipsync", "ltx2_t2v", "ltx2_i2v",
      "frame_interpolate", "dub_lipsync_long", "manju_lipsync", "anime_lipsync",
      // 视频超分(M6 fleet 帧级 4K 管线)
      "video_upscale",
      // LongCat 长视频(t2v/i2v/续写)
      "longcat_t2v", "longcat_i2v", "longcat_continue",
      // LongCat-Avatar 数字人说话视频
      "avatar_talk",
      // Wan2.1-VACE 首尾帧转场
      "transition",
      // VACE 视频到视频编辑(in-context:对象增删换/重打光/换风格/换机位)
      "video_edit",
      // 关键帧链式转场(合并成片;段产物 kind=transition 已在上)
      "keyframe_chain",
      // 短剧 studio 视频类产物
      "drama_shot_video", "drama_shot_video_i2v", "drama_shot_video_v2", "drama_shot_lipsync",
      // 绿幕抠像 / Wan 动作迁移
      "chromakey", "wan_animate", "wan_animate2",
    ],
  },
  {
    key: "audio",
    label: "音频",
    kinds: ["audio", "ace_audio", "audio_sep", "transcribe", "voice_track", "manju_voice"],
  },
  { key: "3d", label: "3D", kinds: ["3d", "model3d", "hunyuan3d", "threed_material", "threed_render", "threed_texture"] },
];

/** 动态前缀规则(后端按 preset/视角拼 kind):cad_* → 3D;drama_char_reference_* → 图像。 */
export const KIND_PREFIX_RULES: [string, FilterKey][] = [
  ["cad_", "3d"],
  ["drama_char_reference_", "image"],
];

/**
 * kind → 筛选桶。未识别的 kind 返回 null:只在「全部」出现,
 * 不硬塞进「图像」(修复 transcribe/voice_track 等被错算成图像的问题)。
 */
/** 类型 chip → 后端 GET /api/jobs?kind= 多值(逗号分隔);「全部」空串不过滤。
 *  前缀 token(以 _ 结尾,如 cad_ / drama_char_reference_)一并送给服务端:
 *  GET /api/jobs 把这类 token 当 startswith,精确值仍 in_(...)。 */
export function kindsQueryForFilter(filter: FilterKey): string {
  if (filter === "all") return "";
  const f = FILTERS.find((x) => x.key === filter);
  const kinds = [...(f?.kinds ?? [])];
  for (const [prefix, key] of KIND_PREFIX_RULES) {
    if (key === filter && !kinds.includes(prefix)) kinds.push(prefix);
  }
  return kinds.length > 0 ? kinds.join(",") : "";
}

/** 忽略过期分页响应(类型 chip 连点竞态):每次 next() 作废更早序号。 */
export function makeSeqGate(): { next(): number; peek(): number; isLive(n: number): boolean } {
  let seq = 0;
  return {
    next() {
      seq += 1;
      return seq;
    },
    peek() {
      return seq;
    },
    isLive(n: number) {
      return n === seq;
    },
  };
}

export function kindToFilter(kind: string): FilterKey | null {
  for (const f of FILTERS) {
    if (f.kinds.includes(kind)) return f.key;
  }
  for (const [prefix, key] of KIND_PREFIX_RULES) {
    if (kind.startsWith(prefix)) return key;
  }
  return null;
}

/** 类型短名:映射后的中文短名;未知 kind 兜底「其他」,不回显超长原始 kind 名。 */
export function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    txt2img: "文生图",
    img2img: "图生图",
    controlnet: "ControlNet",
    upscale: "放大",
    facedetailer: "脸部修复",
    inpaint: "局部重绘",
    removebg: "抠图",
    raw: "原图",
    qwen_edit: "智能编辑",
    video: "视频",
    txt2video: "文生视频",
    img2video: "图生视频",
    lipsync: "对口型",
    kenburns: "运镜",
    wan_t2v: "文生视频",
    wan_i2v: "图生视频",
    hunyuan_i2v: "图生视频",
    h3_t2v: "文生视频",
    h3_i2v: "图生视频",
    h3_multishot: "多镜头",
    h3_extend_i2v: "长视频续写",
    ltx_t2v: "文生视频",
    ltx_i2v: "图生视频",
    ltx_lipsync: "对口型",
    ltx2_t2v: "文生视频",
    ltx2_i2v: "图生视频",
    frame_interpolate: "补帧",
    video_upscale: "视频超分",
    dub_lipsync_long: "长对口型",
    manju_lipsync: "对口型",
    anime_lipsync: "动漫对口型",
    longcat_t2v: "长视频",
    longcat_i2v: "长视频",
    longcat_continue: "长视频续写",
    avatar_talk: "数字人",
    transition: "首尾帧转场",
    video_edit: "视频编辑",
    keyframe_chain: "关键帧链",
    audio: "音频",
    ace_audio: "音乐",
    audio_sep: "人声分离",
    transcribe: "听写",
    voice_track: "配音轨",
    manju_voice: "配音",
    "3d": "3D",
    model3d: "3D",
    hunyuan3d: "图生3D",
    threed_material: "3D 材质",
    threed_render: "3D 渲染",
    threed_texture: "3D 纹理",
    chromakey: "抠像",
    i2l: "风格LoRA",
    motion_brush: "局部动效",
    wan_animate: "动作迁移",
    wan_animate2: "动作迁移2",
    drama_grid_storyboard: "分镜",
    drama_scene_layout: "场景布局",
    drama_shot_video: "镜头视频",
    drama_shot_video_i2v: "镜头视频",
    drama_shot_video_v2: "镜头视频",
    drama_shot_lipsync: "镜头对口型",
    studio_script_parse: "剧本拆解",
  };
  if (map[kind]) return map[kind];
  if (kind.startsWith("cad_")) return "CAD";
  if (kind.startsWith("drama_char_reference_")) return "角色参考";
  return "其他";
}

export function isVideoKind(kind: string): boolean {
  return kindToFilter(kind) === "video";
}

/** 相对时间(中文):<1min 刚刚 / N 分钟前 / N 小时前 / N 天前 / 7 天外落日期。 */
export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000;
    const hr = 60 * min;
    const day = 24 * hr;
    if (diff < min) return "刚刚";
    if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return d.toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

/** 回收站剩余保留期(中文):<1h 剩 N 分钟 / <1d 剩 N 小时 / 否则 剩 D 天 H 小时;≤0 已到期。 */
export function formatRetention(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "已到期";
  const min = 60;
  const hr = 3600;
  const day = 86400;
  if (seconds < hr) return `剩 ${Math.max(1, Math.ceil(seconds / min))} 分钟`;
  if (seconds < day) return `剩 ${Math.floor(seconds / hr)} 小时`;
  const d = Math.floor(seconds / day);
  const h = Math.floor((seconds % day) / hr);
  return h > 0 ? `剩 ${d} 天 ${h} 小时` : `剩 ${d} 天`;
}

/** 作业状态 → 中文短名(状态点 title / 灯箱元信息共用)。 */
export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    done: "已完成",
    running: "生成中",
    error: "失败",
    queued: "排队中",
  };
  return map[status] ?? status;
}

/** 卡片标题/副标拆分结果。 */
export interface CardText {
  /** 标题位文案(语义首段;无元信息串时为完整 prompt)。 */
  title: string;
  /** 副标元信息(分辨率/帧数/时长等;无则 null,不渲染副标行)。 */
  meta: string | null;
}

/**
 * 卡片标题/副标拆分(2026-08-16 视图批 1,审计 P2):
 * 部分作业的 prompt 是后端管线写入的元信息串(视频超分:
 * 「视频超分 4K · 1344×768 → 3840×2160 · 48帧@24fps」),整串当标题截断后可读性差。
 * 此类作业标题只保留首段语义文案,其余「 · 」分段降级为副标一行;
 * 普通用户提示词原样返回(用户文本可能含「 · 」,按 kind 白名单拆分,不误伤)。
 */
export function splitCardTitle(job: Pick<JobItem, "kind" | "prompt">): CardText {
  const prompt = job.prompt ?? "";
  if (job.kind === "video_upscale") {
    const segs = prompt.split(" · ").map((s) => s.trim()).filter(Boolean);
    if (segs.length > 1) {
      return { title: segs[0], meta: segs.slice(1).join(" · ") };
    }
  }
  return { title: prompt, meta: null };
}

export interface LibraryQuery {
  filter: FilterKey;
  contentFilter: ContentFilterKey;
  /** prompt 搜索词(纯客户端,大小写不敏感,首尾空白忽略)。 */
  search: string;
  sort: SortKey;
}

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  filter: "all",
  contentFilter: "all",
  search: "",
  sort: "newest",
};

function createdAtMs(job: JobItem): number {
  const t = Date.parse(job.created_at);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 作品库查询管线:内容分级 → 类型筛选 → prompt 搜索 → 时间排序。
 * 输入不就地修改,返回新数组;空搜索词不参与过滤。
 */
export function applyLibraryQuery(jobs: readonly JobItem[], q: LibraryQuery): JobItem[] {
  // ① 内容维度:SFW = !nsfw,R18 = nsfw;「全部」不过滤
  let out =
    q.contentFilter === "all"
      ? jobs.slice()
      : jobs.filter((j) => (q.contentFilter === "r18" ? !!j.nsfw : !j.nsfw));
  // ② 类型维度:未识别 kind 只在「全部」出现
  if (q.filter !== "all") {
    const filter = q.filter;
    out = out.filter((j) => kindToFilter(j.kind) === filter);
  }
  // ③ prompt 搜索(大小写不敏感子串)
  const needle = q.search.trim().toLowerCase();
  if (needle) {
    out = out.filter((j) => (j.prompt ?? "").toLowerCase().includes(needle));
  }
  // ④ 排序:稳定排序,无效日期沉底(按 0 处理)
  const dir = q.sort === "oldest" ? 1 : -1;
  out.sort((a, b) => (createdAtMs(a) - createdAtMs(b)) * dir);
  return out;
}

/** 各类型计数(chip 徽标):基于内容分级后的集合,未识别 kind 只计入「全部」。 */
export function countByFilter(
  jobs: readonly JobItem[],
  contentFilter: ContentFilterKey,
): Record<FilterKey, number> {
  const counts: Record<FilterKey, number> = { all: 0, image: 0, video: 0, audio: 0, "3d": 0 };
  const base =
    contentFilter === "all"
      ? jobs
      : jobs.filter((j) => (contentFilter === "r18" ? !!j.nsfw : !j.nsfw));
  counts.all = base.length;
  for (const j of base) {
    const key = kindToFilter(j.kind);
    if (key) counts[key]++;
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内容分组(2026-08-24):带 batch_id 的作业(360° 环绕序列同批 8 张)折叠为文件夹卡
// ─────────────────────────────────────────────────────────────────────────────

/** 文件夹:同一 batch_id 的成员集合(顺序沿用传入列表,成员卡行为与普通作品一致)。 */
export interface BatchFolder {
  batchId: string;
  members: JobItem[];
}

/** 主网格条目:普通作品卡 或 文件夹卡。 */
export type LibraryEntry =
  | { type: "job"; job: JobItem }
  | { type: "batch"; folder: BatchFolder };

/**
 * 分组折叠(在 applyLibraryQuery 之后调用,输入已过滤+排序):
 * - 带 batch_id 且同批成员 ≥2 的作业折叠为一个文件夹,位置取首个(最新)成员处;
 * - 成员不足 2 个(其余被删/被筛选掉)回落为普通作品卡;无 batch_id 的旧作业原样;
 * - 筛选后调用 → 文件夹天然按成员 kind 归属对应类型桶(成员全被滤掉即不显示)。
 */
export function groupLibraryEntries(jobs: readonly JobItem[]): LibraryEntry[] {
  const byBatch = new Map<string, JobItem[]>();
  for (const j of jobs) {
    if (!j.batch_id) continue;
    const g = byBatch.get(j.batch_id);
    if (g) g.push(j);
    else byBatch.set(j.batch_id, [j]);
  }
  const emitted = new Set<string>();
  const out: LibraryEntry[] = [];
  for (const j of jobs) {
    const b = j.batch_id;
    if (!b) {
      out.push({ type: "job", job: j });
      continue;
    }
    if (emitted.has(b)) continue;
    emitted.add(b);
    const members = byBatch.get(b) ?? [j];
    if (members.length >= 2) {
      out.push({ type: "batch", folder: { batchId: b, members } });
    } else {
      out.push({ type: "job", job: members[0] });
    }
  }
  return out;
}

/** 文件夹封面:首个有产物的成员(无产物成员回退占位卡)。 */
export function folderCover(folder: BatchFolder): JobItem {
  return (
    folder.members.find((m) => m.status === "done" && m.results?.length > 0) ??
    folder.members[0]
  );
}

/** localStorage 键:网格密度(舒适/紧凑)。 */
export const LIBRARY_DENSITY_KEY = "toiv_library_density";
/** 读取网格密度(SSR/无窗口/值损坏一律回退舒适档)。 */
export function loadDensity(): LibraryDensity {
  if (typeof window === "undefined") return "comfortable";
  try {
    return window.localStorage.getItem(LIBRARY_DENSITY_KEY) === "compact"
      ? "compact"
      : "comfortable";
  } catch {
    return "comfortable";
  }
}

/** 持久化网格密度;localStorage 不可用时静默忽略。 */
export function persistDensity(density: LibraryDensity): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LIBRARY_DENSITY_KEY, density);
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

export interface BatchDeleteResult {
  /** 已成功删除的 id(按传入顺序)。 */
  done: string[];
  /** 删除失败的 id(调用方据此保留选中并提示)。 */
  failed: string[];
}

/**
 * 批量删除:顺序执行(不并发打满后端),单条失败不中断后续;
 * 全部尝试完毕后返回 done/failed 两组(含每条的撤销凭据),由调用方更新列表与选中集。
 */
export async function deleteJobsBatch(
  ids: readonly string[],
  deleteFn: (id: string) => Promise<{ undo_token?: string } | void>,
): Promise<BatchDeleteResult & { undoTokens: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  const undoTokens: string[] = [];
  for (const id of ids) {
    try {
      const r = await deleteFn(id);
      done.push(id);
      const tok = (r as { undo_token?: string } | void)?.undo_token;
      if (tok) undoTokens.push(tok);
    } catch {
      failed.push(id);
    }
  }
  return { done, failed, undoTokens };
}
