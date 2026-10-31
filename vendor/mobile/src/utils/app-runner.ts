/**
 * U10b 应用运行器纯函数：params_schema 归一 / 初值 / 提交载荷 / 必填校验
 * 对齐 apps/web/lib/apps.ts（精简版；不含变体指纹与 H3 加速）
 */

export type AppParamType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'select'
  | 'switch'
  | 'images'
  | 'audio'
  | 'video'
  | 'loras';

export interface AppParamOption {
  value: string;
  label: string;
  nsfw?: boolean;
  desc?: string;
}

export interface AppParam {
  key: string;
  label: string;
  type: AppParamType;
  default: unknown;
  options?: AppParamOption[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  required?: boolean;
  mask?: boolean;
}

/** 小程序本轮可编辑的参数类型（slider 按 number 渲） */
export const SUPPORTED_PARAM_TYPES = new Set<AppParamType>([
  'text',
  'textarea',
  'number',
  'slider',
  'select',
  'switch',
  'images',
]);

/** 本轮显式降级：展示说明，不崩 */
export const DEFERRED_PARAM_TYPES = new Set<AppParamType>(['audio', 'video', 'loras']);

export const MEDIA_PARAM_TYPES = new Set<AppParamType>(['images', 'audio', 'video']);

const PARAM_TYPES: readonly AppParamType[] = [
  'text',
  'textarea',
  'number',
  'slider',
  'select',
  'switch',
  'images',
  'audio',
  'video',
  'loras',
];

function boolOf(v: unknown): boolean {
  return v === true || v === 1;
}

function isRemoteDemoMedia(f: string): boolean {
  return /^https?:\/\//i.test(f.trim());
}

/** params_schema 单项归一：非法 type 兜底 text；default 缺省补 null。 */
export function normalizeParam(raw: unknown): AppParam {
  const p = (raw ?? {}) as Record<string, unknown>;
  const type = PARAM_TYPES.includes(p.type as AppParamType)
    ? (p.type as AppParamType)
    : 'text';
  const out: AppParam = {
    key: String(p.key ?? ''),
    label: String(p.label ?? p.key ?? ''),
    type,
    default: p.default === undefined ? null : p.default,
  };
  if (Array.isArray(p.options)) {
    out.options = p.options
      .map((o) => {
        const r = (o ?? {}) as Record<string, unknown>;
        return {
          value: String(r.value ?? ''),
          label: String(r.label ?? r.value ?? ''),
          ...(boolOf(r.nsfw) ? { nsfw: true } : {}),
          ...(typeof r.desc === 'string' && r.desc ? { desc: r.desc } : {}),
        };
      })
      .filter((o) => o.value !== '' || o.label !== '');
  }
  for (const k of ['min', 'max', 'step'] as const) {
    const n = Number(p[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (typeof p.hint === 'string' && p.hint) out.hint = p.hint;
  if (p.required === true) out.required = true;
  else if (p.required === false) out.required = false;
  if (p.mask === true) out.mask = true;
  return out;
}

export function normalizeParamsSchema(raw: unknown): AppParam[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeParam).filter((p) => p.key !== '');
}

/** 从句柄/字符串抽文件名（远程 demo URL 默认剔除）。 */
export function mediaFilenames(value: unknown, includeRemoteDemo = false): string[] {
  if (value == null || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const f = item.trim();
      if (!f) continue;
      if (!includeRemoteDemo && isRemoteDemoMedia(f)) continue;
      out.push(f);
    } else if (item && typeof item === 'object' && 'filename' in item) {
      const f = String((item as { filename: unknown }).filename ?? '').trim();
      if (!f) continue;
      if (!includeRemoteDemo && isRemoteDemoMedia(f)) continue;
      out.push(f);
    }
  }
  return out;
}

/** 打开应用时的表单初值。 */
export function schemaInitialValues(schema: AppParam[]): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const p of schema) {
    if (MEDIA_PARAM_TYPES.has(p.type)) {
      v[p.key] = [];
    } else if (p.type === 'switch') {
      v[p.key] = p.default === true;
    } else if (p.type === 'number' || p.type === 'slider') {
      v[p.key] = p.default == null ? '' : p.default;
    } else {
      v[p.key] = p.default ?? '';
    }
  }
  return v;
}

/**
 * 提交载荷：number 空串省略；switch 布尔；images 抽 filename 数组；
 * audio/video/loras 本轮不提交空数组以免误覆盖（缺省由后端 default）。
 */
export function buildRunValues(
  schema: AppParam[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of schema) {
    if (p.mask === true) continue;
    if (DEFERRED_PARAM_TYPES.has(p.type)) continue;
    const v = values[p.key];
    if (p.type === 'number' || p.type === 'slider') {
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[p.key] = v;
        continue;
      }
      const raw = String(v ?? '').trim();
      if (!raw) continue;
      const n = Number(raw);
      if (Number.isFinite(n)) out[p.key] = n;
      continue;
    }
    if (p.type === 'switch') {
      out[p.key] = Boolean(v);
      continue;
    }
    if (p.type === 'images') {
      out[p.key] = mediaFilenames(v, false);
      continue;
    }
    if (Array.isArray(v)) {
      out[p.key] = v;
      continue;
    }
    out[p.key] = String(v ?? '');
  }
  return out;
}

/**
 * 必填缺口 → 参数 label；无缺口 null。
 * - switch 永不卡
 * - required===false 跳过
 * - images：无已上传文件名则卡（远程 demo 不算）
 * - 遮罩/音频/视频/loras：若必填则返回 label（小程序本轮不可填）
 * - 其余：default==null 或 required===true 且值为空 → 卡
 */
export function requiredParamLabel(
  schema: AppParam[],
  values: Record<string, unknown>,
): string | null {
  for (const p of schema) {
    if (p.type === 'switch') continue;
    if (p.required === false) continue;
    const v = values[p.key];
    // 遮罩 / 音频 / 视频 / loras：本轮不可填，仅必填时卡住引导去 Web
    if (p.mask === true || DEFERRED_PARAM_TYPES.has(p.type)) {
      if (p.required === true || p.default == null) return p.label;
      continue;
    }
    if (p.type === 'images') {
      if (mediaFilenames(v, false).length === 0) return p.label;
      continue;
    }
    if (p.required === true) {
      if (v == null || String(v).trim() === '') return p.label;
      continue;
    }
    if (p.default != null) continue;
    if (v == null || String(v).trim() === '') return p.label;
  }
  return null;
}

/** 本轮是否可在表单内编辑（images 非 mask）。 */
export function isEditableParam(p: AppParam): boolean {
  if (p.mask === true) return false;
  return SUPPORTED_PARAM_TYPES.has(p.type);
}

/** 本轮降级说明用。 */
export function isDeferredParam(p: AppParam): boolean {
  return p.mask === true || DEFERRED_PARAM_TYPES.has(p.type);
}

/** 上传 kind：与 Web appUploadKind 同口径。 */
export function appUploadKind(appId: string): string {
  if (appId.startsWith('h3-')) return 'h3_i2v';
  if (appId.startsWith('wan-animate-2')) return 'wan_animate2';
  if (appId.startsWith('wan-animate')) return 'wan_animate';
  if (appId === 'wan-vace' || appId === 'vace-edit' || appId === 'wan-transition') return 'wan_vace';
  if (appId.startsWith('longcat-') || appId.startsWith('phantom-') || appId.startsWith('ovi-')) {
    return 'avatar';
  }
  if (appId.startsWith('avatar')) return 'avatar';
  if (appId.startsWith('ltx')) return appId.includes('lipsync') ? 'ltx_lipsync' : 'ltx_i2v';
  return 'img2img';
}

/** 双模式卡：content_modes 同时含 sfw+nsfw。 */
export function hasDualContentModes(modes?: string[] | null): boolean {
  const m = modes ?? [];
  return m.includes('sfw') && m.includes('nsfw');
}
