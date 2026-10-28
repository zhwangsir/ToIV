import type { DesktopAppDef, InstalledApp, Placement, TaskbarState, DesktopPrefs } from "./types";

/** OS App catalog — ids 稳定；工作流 wf: 另轨不进本表主键 */
export const DESKTOP_APP_CATALOG: DesktopAppDef[] = [
  // —— 系统级预装 7 ——
  { id: "create", name: "创作", entry: "/create", match: ["/create"], chrome: "creation", system: true, preinstall: true, catalog: true, description: "创作台", icon: "wand" },
  { id: "drama", name: "短剧项目", entry: "/toiv/drama", match: ["/toiv/drama"], chrome: "sidebar", system: true, preinstall: true, catalog: true, description: "短剧列表与工作区", icon: "clapperboard" },
  { id: "tasks", name: "任务中心", entry: "/tasks", match: ["/tasks", "/toiv/tasks"], chrome: "sidebar", system: true, preinstall: true, catalog: true, description: "任务与队列", icon: "list-checks" },
  { id: "market-tools", name: "工具台", entry: "/toiv/market", match: ["/toiv/market"], chrome: "sidebar", system: true, preinstall: true, catalog: true, description: "产品工具箱（≠ 应用商店）", icon: "wrench" },
  { id: "settings", name: "设置", entry: "/settings", match: ["/settings"], chrome: "sidebar", system: true, preinstall: true, catalog: true, description: "账号与偏好", icon: "settings" },
  { id: "library", name: "媒体库", entry: "/library", match: ["/library"], chrome: "sidebar", system: true, preinstall: true, catalog: true, description: "作品与素材", icon: "library" },
  { id: "app-store", name: "应用商店", entry: "/desktop/store", match: ["/desktop/store"], chrome: "store", system: true, preinstall: true, catalog: true, description: "安装桌面应用", icon: "store" },
  // —— 可卸预装 4 ——
  { id: "canvas-lib", name: "画布库", entry: "/project", match: ["/project", "/projects"], chrome: "sidebar", system: false, preinstall: true, catalog: true, description: "自由画布项目库", icon: "layout" },
  { id: "canvas-new", name: "新建画布", entry: "/canvas?mode=new", match: [], chrome: "none", system: false, preinstall: true, catalog: true, description: "新建画布项目", icon: "plus-square" },
  { id: "agents", name: "外部 Agent", entry: "/agents", match: ["/agents"], chrome: "sidebar", system: false, preinstall: true, catalog: true, description: "外部智能体", icon: "bot" },
  { id: "kpi", name: "学习看板", entry: "/toiv/kpi", match: ["/toiv/kpi"], chrome: "sidebar", system: false, preinstall: true, catalog: true, description: "学习与 KPI", icon: "chart" },
  // —— 目录可装（非预装）——
  { id: "plugins", name: "插件中心", entry: "/plugins", match: ["/plugins"], chrome: "sidebar", system: false, preinstall: false, catalog: true, description: "插件管理", icon: "plug" },
  { id: "plugins-eagle", name: "Eagle 素材库", entry: "/plugins/eagle", match: ["/plugins/eagle"], chrome: "sidebar", system: false, preinstall: false, catalog: true, description: "Eagle 插件", icon: "image" },
  { id: "voice-lab", name: "录音测试", entry: "/test-voice-recording", match: ["/test-voice-recording"], chrome: "sidebar", system: false, preinstall: false, catalog: true, description: "实验室", icon: "mic" },
];

/** M2 首批真封装 App（打开走现路由进窗 · 单例聚焦） */
export const M2_ENCAPSULATED_APP_IDS = [
  "create",
  "drama",
  "tasks",
  "market-tools",
  "settings",
  "library",
] as const;

export type M2EncapsulatedAppId = (typeof M2_ENCAPSULATED_APP_IDS)[number];

export function isM2EncapsulatedApp(id: string): boolean {
  return (M2_ENCAPSULATED_APP_IDS as readonly string[]).includes(id);
}

export const DEFAULT_THEME_ID = "toiv-noir" as const;

export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  iconSize: "md",
  themeId: DEFAULT_THEME_ID,
};

export const DEFAULT_TASKBAR: TaskbarState = {
  order: ["create", "drama", "tasks", "market-tools", "library", "app-store", "settings"],
  showStore: true,
  showStart: true,
};

export function getAppDef(id: string): DesktopAppDef | undefined {
  return DESKTOP_APP_CATALOG.find((a) => a.id === id);
}

export function resolveAppIdByPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return null;
  // longer match first
  const ranked = [...DESKTOP_APP_CATALOG].sort((a, b) => {
    const am = Math.max(0, ...a.match.map((m) => m.length));
    const bm = Math.max(0, ...b.match.map((m) => m.length));
    return bm - am;
  });
  for (const app of ranked) {
    for (const prefix of app.match) {
      if (pathname === prefix || pathname.startsWith(prefix + "/")) return app.id;
    }
  }
  // /canvas 列表或 /canvas/:id 编辑器 → 画布库单例（编辑器窗内 hideChrome）
  if (pathname === "/canvas" || pathname.startsWith("/canvas/")) return "canvas-lib";
  return null;
}

export function buildDefaultInstalled(now = new Date().toISOString()): InstalledApp[] {
  return DESKTOP_APP_CATALOG.filter((a) => a.preinstall).map((a) => ({
    id: a.id,
    installedAt: now,
    source: "preinstall" as const,
    pinnedToTaskbar: DEFAULT_TASKBAR.order.includes(a.id),
  }));
}

/** Auto-grid placements for visible installed apps (single column-major) */
export function buildDefaultPlacements(installed: InstalledApp[], cols = 1): Placement[] {
  const visible = installed.filter((i) => !i.hidden);
  return visible.map((item, index) => ({
    targetId: item.id,
    kind: "app" as const,
    col: cols === 1 ? 0 : index % cols,
    row: cols === 1 ? index : Math.floor(index / cols),
    monitor: 0 as const,
  }));
}

export function isWorkflowAppId(id: string): boolean {
  return id.startsWith("wf:");
}
