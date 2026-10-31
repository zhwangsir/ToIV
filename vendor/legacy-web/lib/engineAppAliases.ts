/**
 * Similar-merge P1 Slice B #20 — 引擎工作台 id ↔ 市场 *-basic 展示别名表。
 * **仅 UI 展示**；禁止改 submit route / engine registry 稳定 id。
 */
export interface EngineAppDisplayAlias {
  /** 市场应用 id（*-basic） */
  marketAppId: string;
  /** 用户可见短名 */
  displayName: string;
  /** 引擎工作台 registry id（txt2img / img2img 等） */
  engineId: string;
}

/** 双向可查：engine id 与 market app id 共用同一展示名。 */
export const ENGINE_APP_DISPLAY_ALIASES: Readonly<Record<string, EngineAppDisplayAlias>> = {
  txt2img: {
    engineId: "txt2img",
    marketAppId: "txt2img-basic",
    displayName: "Flux2 文生图",
  },
  "txt2img-basic": {
    engineId: "txt2img",
    marketAppId: "txt2img-basic",
    displayName: "Flux2 文生图",
  },
  img2img: {
    engineId: "img2img",
    marketAppId: "img2img-basic",
    displayName: "Flux2 图生图",
  },
  "img2img-basic": {
    engineId: "img2img",
    marketAppId: "img2img-basic",
    displayName: "Flux2 图生图",
  },
} as const;

export function resolveEngineAppDisplayName(id: string): string | null {
  return ENGINE_APP_DISPLAY_ALIASES[id]?.displayName ?? null;
}

export function resolveMarketAppIdForEngine(engineId: string): string | null {
  return ENGINE_APP_DISPLAY_ALIASES[engineId]?.marketAppId ?? null;
}
