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
      // 应用市场产物(2026-09-15:Job.kind 按应用 output_kind 派生,app_run 已回填)
      "app_image",
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
      // 应用市场产物(视频类应用)
      "app_video",
      // 短剧 studio 视频类产物
      "drama_shot_video", "drama_shot_video_i2v", "drama_shot_video_v2", "drama_shot_lipsync",
      // 绿幕抠像 / Wan 动作迁移
      "chromakey", "wan_animate", "wan_animate2",
    ],
  },
  {
    key: "audio",
    label: "音频",
    kinds: ["audio", "ace_audio", "audio_sep", "transcribe", "voice_track", "manju_voice", "app_audio"],
  },
  { key: "3d", label: "3D", kinds: ["3d", "model3d", "hunyuan3d", "threed_material", "threed_render", "threed_texture", "app_3d"] },
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
    // 应用市场产物(2026-09-15:kind 按应用产物类型派生;app_run=历史遗留/失败作业)
    app_image: "应用·图像",
    app_video: "应用·视频",
    app_audio: "应用·音频",
    app_3d: "应用·3D",
    app_run: "应用",
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
  /** 来源筛选(2026-09-20 作品库优化 A2):空=全部;engine:{kind}=引擎族;app:{appId}=来源应用。 */
  source?: string;
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
  // ②.5 来源维度:引擎族按 kind 精确;应用按 app_id 精确(纯前端,数据已随列表)
  if (q.source) {
    const src = q.source;
    out = out.filter((j) =>
      src.startsWith("engine:")
        ? j.kind === src.slice(7)
        : src.startsWith("app:")
          ? !!j.app_id && j.app_id === src.slice(4)
          : true,
    );
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

/** 支持「重试」的 kind 白名单(2026-09-20,与后端 _rerun_registry 镜像)。
 *  含上传媒体但后端原生支持解析的 wan_i2v/img2img 等在内;不在表内的
 *  (h3_i2v/longcat_i2v/应用运行等)前端不显示重试按钮,引导「复用提示词」。 */
export const RERUNNABLE_KINDS: ReadonlySet<string> = new Set([
  "txt2img", "nsfw-txt2img", "img2img", "nsfw-img2img",
  "controlnet", "upscale", "facedetailer", "raw",
  "removebg", "inpaint", "wan_t2v", "wan_i2v",
  "hunyuan3d", "ace_audio", "audio",
  "manju_lipsync", "manju_shot_txt2img", "manju_shot_ipadapter",
  "video_upscale",
  "h3_t2v", "h3_multishot", "longcat_t2v", "ovi_t2v", "ltx_t2v",
]);

/** 作品可否一键重试(白名单 ∧ 有参数快照)。 */
export function canRerun(j: JobItem): boolean {
  return RERUNNABLE_KINDS.has(j.kind) && !!j.has_params && j.status !== "queued"
    && j.status !== "running" && j.status !== "held";
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

// ─────────────────────────────────────────────────────────────────────────────
// 灯箱展平条目(2026-09-15 用户拍板):单作业多产物(如一次生成 N 张多视角图)
// 在灯箱内逐张翻看,而不是只能看到 results[0]。作业按原顺序展开为
// {job, url} 条目序列;无产物作业保留为占位条目(灯箱显示类型占位)。
// ─────────────────────────────────────────────────────────────────────────────

/** 灯箱单个可浏览条目:某作业的第 index 张产物;placeholder=true 表示无产物占位。 */
export interface LightboxEntry {
  job: JobItem;
  url: string;
  /** 本作业内的产物序号(0 基) */
  index: number;
  /** 本作业产物总数(占位条目为 0) */
  count: number;
  placeholder: boolean;
}

/** 作业列表 → 灯箱条目序列:done 作业逐产物展开,其余保留单个占位条目。 */
export function flattenLightboxEntries(jobs: readonly JobItem[]): LightboxEntry[] {
  const out: LightboxEntry[] = [];
  for (const job of jobs) {
    const results = job.status === "done" ? (job.results ?? []) : [];
    if (results.length === 0) {
      out.push({ job, url: "", index: 0, count: 0, placeholder: true });
      continue;
    }
    for (let i = 0; i < results.length; i++) {
      out.push({ job, url: results[i], index: i, count: results.length, placeholder: false });
    }
  }
  return out;
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

// ─────────────────────────────────────────────────────────────
// 2026-09-20 作品库 P1:收藏 / 时间分组 / 元数据桥(纯函数层)
// ─────────────────────────────────────────────────────────────

const FAVORITES_KEY = "toiv_library_favorites";

/** 收藏集(jobId 集合):localStorage 持久,纯前端 P1;跨端同步留 P2(preferences 表)。 */
export function loadFavorites(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveFavorites(ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...ids]));
  } catch {
    /* 隐私模式等写不进就算了 */
  }
}

/** 时间分组槽(排序=最新时):今天/昨天/本周/本月/更早。 */
export type TimeSlotKey = "today" | "yesterday" | "week" | "month" | "older";

export const TIME_SLOT_LABELS: Record<TimeSlotKey, string> = {
  today: "今天",
  yesterday: "昨天",
  week: "近 7 天",
  month: "近 30 天",
  older: "更早",
};

export interface TimeGroup {
  key: TimeSlotKey;
  label: string;
  jobs: JobItem[];
}

/** startOfDay(ms) 的本地时区实现(不依赖 date-fns)。 */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 单条作品的时间槽(今天/昨天/近7天/近30天/更早);now 可注入便于测试。 */
export function timeSlotKeyOf(ms: number, now: number = Date.now()): TimeSlotKey {
  const todayStart = startOfLocalDay(now);
  if (ms >= todayStart) return "today";
  if (ms >= todayStart - 86400_000) return "yesterday";
  if (ms >= todayStart - 6 * 86400_000) return "week";
  if (ms >= todayStart - 29 * 86400_000) return "month";
  return "older";
}

/** 作品按时间槽分组(输入须已按新→旧排好序;组内保持原序)。 */
export function groupJobsByTimeSlot(jobs: readonly JobItem[], now: number = Date.now()): TimeGroup[] {
  const buckets: Record<TimeSlotKey, JobItem[]> = {
    today: [], yesterday: [], week: [], month: [], older: [],
  };
  for (const j of jobs) {
    buckets[timeSlotKeyOf(createdAtMs(j), now)].push(j);
  }
  const meta: { key: TimeSlotKey; label: string }[] = (
    Object.entries(TIME_SLOT_LABELS) as [TimeSlotKey, string][]
  ).map(([key, label]) => ({ key, label }));
  return meta
    .filter((m) => buckets[m.key].length > 0)
    .map((m) => ({ key: m.key, label: m.label, jobs: buckets[m.key] }));
}

/** 元数据桥:复制参数块(站外重建上下文;PNG 图 ComfyUI 已内嵌 workflow,此为显式文本桥)。 */
export function buildMetaBlock(job: JobItem): string {
  const lines = [
    `# ToIV 作品参数 · ${job.kind}`,
    `prompt: ${job.prompt || "(无)"}`,
    `seed: ${job.seed}`,
  ];
  if (job.meta?.width && job.meta?.height) {
    lines.push(`size: ${job.meta.width}x${job.meta.height}`);
  }
  if (typeof job.meta?.steps === "number") lines.push(`steps: ${job.meta.steps}`);
  if (typeof job.duration === "number") lines.push(`duration: ${job.duration}s`);
  lines.push(`created_at: ${job.created_at}`);
  lines.push(`job_id: ${job.id}`);
  return lines.join("\n");
}

/** PNG 是否内嵌 ComfyUI workflow/prompt(tEXt/zTXt 块关键字探测)。 */
export function pngHasWorkflow(bytes: Uint8Array): boolean {
  // PNG 签名 8 字节;其后为 [len(4) type(4) data(len) crc(4)] 链
  if (bytes.length < 8) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return false;
  const decoder = new TextDecoder();
  let off = 8;
  const needles = ["workflow", "prompt"];
  while (off + 8 <= bytes.length) {
    const len = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    const type = decoder.decode(bytes.subarray(off + 4, off + 8));
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      // 只扫块头 4KB 关键字,避免大块全解码
      const head = bytes.subarray(off + 8, Math.min(off + 8 + len, off + 8 + 4096));
      const text = decoder.decode(head).toLowerCase();
      if (needles.some((n) => text.includes(n))) return true;
    }
    off += 8 + len + 4;
    if (type === "IEND") break;
  }
  return false;
}
