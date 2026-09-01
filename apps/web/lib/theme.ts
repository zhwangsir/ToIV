/**
 * 主题系统 v8(2026-08-31,Studio Console):单色中性系,只剩两个维度。
 * - 模式:light(默认,:root)/ dark(data-mode="dark");持久化 localStorage["toiv_mode"]。
 * - 纯黑子档:仅暗色生效的画布纯黑开关;与旧「自定义」同 key(toiv_theme_custom,
 *   仅存 {pureBlack:true};旧 accent 字段读取时剥离,旧 toiv_theme 色板 key 读取时清除)。
 * - layout.tsx 内联脚本首帧前读两 key 写 dataset 防 FOUC。
 * 退役:v7 的五色板(data-theme)与自定义 accent(inline 注入)全部移除。
 */

export type Mode = "light" | "dark";

export const MODE_STORAGE_KEY = "toiv_mode";
export const CUSTOM_STORAGE_KEY = "toiv_theme_custom";
/** 旧色板 key(v7 及以前);v8 首次读取即清除(见 migrateLegacyKeys) */
export const LEGACY_THEME_KEY = "toiv_theme";

/** 同页多实例同步总线:apply* 广播本事件,其余实例订阅刷新选中态。 */
export const THEME_CHANGED_EVENT = "toiv:theme-changed";

export interface ThemeChangedDetail {
  mode?: Mode;
  custom?: ThemeCustom;
}

function broadcastThemeChanged(detail: ThemeChangedDetail): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail }));
}

/** 同步 <meta name="theme-color"> 为当前画布色(--bg-canvas 计算值);meta 缺失时创建 */
function syncThemeColorMeta(): void {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg-canvas")
    .trim();
  if (!value) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  if (meta.content !== value) meta.content = value;
}

/** 旧版残留清理(幂等):色板 key 删除;自定义里的 accent 字段剥离(只剩 pureBlack) */
function migrateLegacyKeys(): void {
  try {
    window.localStorage.removeItem(LEGACY_THEME_KEY);
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Record<string, unknown> | null;
      if (o && "accent" in o) {
        const { accent: _drop, ...rest } = o;
        if (rest.pureBlack === true) {
          window.localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify({ pureBlack: true }));
        } else {
          window.localStorage.removeItem(CUSTOM_STORAGE_KEY);
        }
      }
    }
    // 旧 data-theme 属性(同标签页旧 bundle 残留)一并清除
    if (typeof document !== "undefined") delete document.documentElement.dataset.theme;
  } catch {
    /* localStorage 不可用时跳过 */
  }
}

/** 读取当前模式(SSR 安全,服务端回落 light) */
export function getCurrentMode(): Mode {
  if (typeof window === "undefined") return "light";
  try {
    migrateLegacyKeys();
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** 自定义子档:v8 只剩 pureBlack(旧 accent 字段读取时剥离) */
export interface ThemeCustom {
  pureBlack?: boolean;
}

/** 读取纯黑子档(SSR 安全;损坏 JSON 回落 {}) */
export function getCustom(): ThemeCustom {
  if (typeof window === "undefined") return {};
  try {
    migrateLegacyKeys();
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Partial<ThemeCustom> | null;
    return o && o.pureBlack === true ? { pureBlack: true } : {};
  } catch {
    return {};
  }
}

/** 把模式写到 documentElement.dataset.mode(不写 localStorage;跨页同步时复用) */
export function applyModeDataset(mode: Mode): void {
  if (mode === "dark") {
    document.documentElement.dataset.mode = "dark";
  } else {
    delete document.documentElement.dataset.mode;
  }
  syncThemeColorMeta();
}

/** 应用模式:写 localStorage + documentElement.dataset.mode,无刷新即时生效 */
export function applyMode(mode: Mode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  applyModeDataset(mode);
  broadcastThemeChanged({ mode });
}

/** 纯黑子档写 DOM(dataset.pureBlack),不写 localStorage(跨页同步复用) */
export function applyCustomDom(c: ThemeCustom): void {
  if (c.pureBlack) {
    document.documentElement.dataset.pureBlack = "1";
  } else {
    delete document.documentElement.dataset.pureBlack;
  }
  syncThemeColorMeta();
}

/** 应用纯黑子档:写 localStorage(关闭则移除 key)→ 写 DOM */
export function applyCustom(c: ThemeCustom): void {
  try {
    if (c.pureBlack) {
      window.localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify({ pureBlack: true }));
    } else {
      window.localStorage.removeItem(CUSTOM_STORAGE_KEY);
    }
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  applyCustomDom(c);
  broadcastThemeChanged({ custom: c });
}
