/** App Shell · desktop domain types (M1 · toiv.desktop.v1) */
export type DesktopThemeId = "toiv-noir" | (string & {});

export type InstalledAppSource = "preinstall" | "store" | "import";

export type InstalledApp = {
  id: string;
  installedAt: string;
  source: InstalledAppSource;
  /** system App「卸载」= 隐藏，不可从 catalog 删除 */
  hidden?: boolean;
  pinnedToTaskbar?: boolean;
};

export type DesktopFolder = {
  id: string;
  name: string;
  appIds: string[];
};

export type Placement = {
  targetId: string;
  kind: "app" | "folder";
  col: number;
  row: number;
  monitor?: 0;
};

export type TaskbarState = {
  order: string[];
  showStore: true;
  showStart: true;
};

/**
 * Desktop chrome prefs only.
 * themeId 预留多皮肤（XP/mac/98 等包走 M1.5/M2）；M1 出厂仅 toiv-noir。
 * 皮肤只动 DesktopShell chrome（壁纸/开始/任务栏/窗框）；App 内容区仍 BeefTV+A6。
 * 禁：会员锁主题、玩笑广告、跳出登录墙。
 */
export type DesktopPrefs = {
  iconSize: "sm" | "md" | "lg";
  /** 默认 toiv-noir；多套皮肤包后波 */
  themeId: DesktopThemeId;
};

export type DesktopBackupV1 = {
  version: 1;
  exportedAt: string;
  schema: "toiv.desktop.v1";
  installed: InstalledApp[];
  folders: DesktopFolder[];
  placements: Placement[];
  taskbar?: TaskbarState;
  prefs?: DesktopPrefs;
};

export type WindowState = "normal" | "minimized" | "maximized";

export type WindowBounds = { x: number; y: number; w: number; h: number };

export type WindowInstance = {
  instanceId: string;
  appId: string;
  entry: string;
  state: WindowState;
  bounds?: WindowBounds;
  z: number;
  title?: string;
};

export type SessionWindows = {
  stack: WindowInstance[];
  focusedId: string | null;
};

export type DesktopChromeKind = "none" | "sidebar" | "creation" | "store";

export type DesktopAppDef = {
  id: string;
  name: string;
  entry: string;
  /** path prefixes that belong to this app */
  match: string[];
  chrome: DesktopChromeKind;
  system: boolean;
  preinstall: boolean;
  /** catalog listing (store) */
  catalog: boolean;
  description?: string;
  icon: string; // lucide icon key
};
