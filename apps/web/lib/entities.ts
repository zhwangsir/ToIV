"use client";

import { useEffect, useRef, useState } from "react";

import { apiFetch, authHeaders, imageUrl } from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// 全局主体库(@主体引用前台化):实体清单 + prompt 内 @提及的解析/插入/移除。
//
// 数据源:GET /api/entities(「全局主体库」任务提供);未就绪时回退既有
// GET /api/assets(参考资产库 ReferenceAsset),两者同构(id/name/kind/images),
// 接口就绪后自动切换,前端其余部分零改动。
//
// @提及语法:`@实体名`(与 Vidu Q3 同款);编号 = 提及在文本中的首次出现顺序,
// 与后端 h3_refs.resolve_entity_refs 的 entity_ids 顺序一一对应(图N=第 N 个提及)。
// ─────────────────────────────────────────────────────────────────────────────

/** 主体库实体(前端同构视图)。 */
export interface EntityInfo {
  id: string;
  name: string;
  /** character | scene | prop | style | ...(后端枚举外值原样透传) */
  kind: string;
  /** 缩略图 URL(首图;无图为空串,选择器/chip 退化为图标占位) */
  thumbUrl: string;
  /** 参考图张数(绑定详情展示「图N」用) */
  imageCount: number;
  description?: string;
}

/** kind → 中文短名(选择器与绑定详情展示)。 */
export const ENTITY_KIND_LABEL: Record<string, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  style: "风格",
};

export function entityKindLabel(kind: string): string {
  return ENTITY_KIND_LABEL[kind] ?? "主体";
}

/** 实体缩略图可访问 URL(附带令牌:<img> 无法带请求头,经 api.imageUrl 统一);无图 → 空串。 */
export function entityThumbUrl(entity: EntityInfo): string {
  return entity.thumbUrl ? imageUrl(entity.thumbUrl) : "";
}

/** /api/entities(P1 主体库)响应形(routes/entities.EntityOut)。 */
interface EntityRow {
  id: string;
  kind: string;
  name: string;
  description?: string;
  /** 预览 URL 字典(slot→/api/entities/{id}/images/{slot});句柄/URL 形态由后端归一 */
  image_urls?: Record<string, string>;
}

/** 缩略图槽位优先级:与后端 best_image_value 同序(正面 → 单图 → 侧面 → 背面)。 */
const THUMB_SLOT_ORDER = ["front", "ref", "side", "back"];

function entityRowToInfo(e: EntityRow): EntityInfo {
  const urls = e.image_urls ?? {};
  const slots = THUMB_SLOT_ORDER.filter((s) => urls[s]);
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    thumbUrl: slots.length > 0 ? urls[slots[0]] : "",
    imageCount: Object.keys(urls).length,
    description: e.description ?? "",
  };
}

/** /api/assets(ReferenceAsset,旧参考资产库)响应形 → EntityInfo。 */
interface AssetRow {
  id: string;
  kind: string;
  name: string;
  description?: string;
  images?: unknown[];
}

function assetToEntity(a: AssetRow): EntityInfo {
  const count = Array.isArray(a.images) ? a.images.length : 0;
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    thumbUrl: count > 0 ? `/api/assets/${a.id}/images/0` : "",
    imageCount: count,
    description: a.description ?? "",
  };
}

/** EntityInfo 数组归一:无名实体剔除(无法被 @ 匹配)。 */
function normalizeEntities(rows: EntityInfo[]): EntityInfo[] {
  return rows.filter((e) => typeof e.name === "string" && e.name.trim().length > 0);
}

/**
 * 拉取主体库清单:GET /api/entities(P1 主体库);未就绪/失败回退旧参考资产库
 * /api/assets。两处都不可用 → 空数组(@ 选择器静默不弹,纯文本输入不受影响)。
 */
export async function fetchEntities(signal?: AbortSignal): Promise<EntityInfo[]> {
  try {
    const res = await apiFetch(`/api/entities`, { headers: authHeaders(), signal });
    if (res.ok) {
      const rows = (await res.json()) as EntityRow[];
      return normalizeEntities(rows.map(entityRowToInfo));
    }
  } catch {
    /* 主体库未就绪/网络抖动 → 回退旧资产库 */
  }
  try {
    const res = await apiFetch(`/api/assets`, { headers: authHeaders(), signal });
    if (!res.ok) return [];
    const rows = (await res.json()) as AssetRow[];
    return normalizeEntities(rows.map(assetToEntity));
  } catch {
    return [];
  }
}

// ── 模块级共享缓存(三处消费方 GenerateView/ImageEditView/助手共用一次拉取) ──
let _cache: EntityInfo[] | null = null;
let _inflight: Promise<EntityInfo[]> | null = null;

function loadEntitiesShared(): Promise<EntityInfo[]> {
  if (_cache) return Promise.resolve(_cache);
  if (_inflight) return _inflight;
  _inflight = fetchEntities()
    .then((rows) => {
      _cache = rows;
      return rows;
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

/** 主体库清单 hook:模块级缓存 + 单飞去重;失败静默为空(@ 功能自动隐身)。 */
export function useEntities(): EntityInfo[] {
  const [entities, setEntities] = useState<EntityInfo[]>(_cache ?? []);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    loadEntitiesShared().then((rows) => {
      if (!cancelled && mountedRef.current) setEntities(rows);
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);
  return entities;
}

// ─────────────────────────────────────────────────────────────────────────────
// @ 提及解析(纯函数,单测锚点)
// ─────────────────────────────────────────────────────────────────────────────

/** 光标处活动中的 @ 触发词。 */
export interface ActiveMention {
  /** `@` 字符在文本中的下标 */
  start: number;
  /** `@` 之后到光标为止的过滤词(不含空白;空串 = 刚输入 @) */
  query: string;
}

const _WS = /\s/;

/**
 * 探测光标处是否处于 @ 触发态:
 * - 光标前一个字符起向左扫描,遇空白停止;停在 `@` 则命中;
 * - 触发词含空白(用户继续在词后输入了空格)→ 非触发态;
 * - 不设「@ 前置空白」守卫:中文语境常直接跟在正文后输入 @(「西部片的@牛仔」),
 *   与助手 @ 技能面板(lastIndexOf)同一语义;邮箱 a@b 误触发由用户 Esc/继续输入收敛。
 */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  if (caret <= 0 || caret > text.length) return null;
  let i = caret - 1;
  while (i >= 0 && text[i] !== "@" && !_WS.test(text[i])) i--;
  if (i < 0 || text[i] !== "@") return null;
  return { start: i, query: text.slice(i + 1, caret) };
}

/** 按过滤词筛选实体(大小写不敏感的名称子串;空词 = 全量)。 */
export function filterEntities(entities: EntityInfo[], query: string): EntityInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return entities;
  return entities.filter((e) => e.name.toLowerCase().includes(q));
}

/** 文本中一处已解析的 @ 提及。 */
export interface EntityMention {
  entity: EntityInfo;
  /** `@` 起始下标 */
  start: number;
  /** 名称结束下标(不含尾随空白) */
  end: number;
}

/**
 * 解析文本中的 @实体名 提及:
 * - 从左到右扫描,`@` 后按「最长实体名优先」匹配(防「牛仔」吃掉「牛仔帽」的前缀);
 * - 同一实体多处提及只认首次(编号 = 首次出现顺序,与后端 entity_ids 序一致);
 * - 结果按 start 升序。
 */
export function parseMentions(text: string, entities: EntityInfo[]): EntityMention[] {
  if (!text.includes("@") || entities.length === 0) return [];
  const pool = [...entities].sort((a, b) => b.name.length - a.name.length);
  const seen = new Set<string>();
  const out: EntityMention[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    const rest = text.slice(at + 1);
    const hit = pool.find((e) => !seen.has(e.id) && rest.startsWith(e.name));
    if (hit) {
      seen.add(hit.id);
      out.push({ entity: hit, start: at, end: at + 1 + hit.name.length });
    }
    i = at + 1;
  }
  return out;
}

/** 提交用:文本 → entity_ids(提及首次出现顺序;后端按此序生成 @图片N)。 */
export function resolveEntityIds(text: string, entities: EntityInfo[]): string[] {
  return parseMentions(text, entities).map((m) => m.entity.id);
}

/**
 * 在 trigger 处插入实体提及:`@名字 `(尾随一个空格与后文分隔)。
 * 返回新文本与新光标位置(名字后空格之后)。
 */
export function insertMention(
  text: string,
  trigger: ActiveMention,
  entity: EntityInfo,
  caret: number,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}@${entity.name} ${text.slice(caret)}`;
  return { text: next, caret: trigger.start + 1 + entity.name.length + 1 };
}

/**
 * 移除一处提及:删掉 `@名字` 本体,并吸收一个相邻分隔空格(优先尾随,其次前导),
 * 保证删 chip 后文本不残留双空格。
 */
export function removeMention(text: string, m: EntityMention): string {
  let { start, end } = m;
  if (text[end] === " ") end += 1;
  else if (start > 0 && text[start - 1] === " ") start -= 1;
  return text.slice(0, start) + text.slice(end);
}
