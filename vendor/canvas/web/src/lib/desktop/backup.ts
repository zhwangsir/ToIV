import type {
  DesktopBackupV1,
  DesktopFolder,
  DesktopPrefs,
  InstalledApp,
  Placement,
  TaskbarState,
} from "./types";
import { DEFAULT_DESKTOP_PREFS, DEFAULT_TASKBAR, DESKTOP_APP_CATALOG, getAppDef } from "./catalog";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizeInstalled(raw: unknown, now: string): InstalledApp[] {
  if (!Array.isArray(raw)) return [];
  const out: InstalledApp[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ id: item, installedAt: now, source: "import" });
      continue;
    }
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    if (!id) continue;
    const source = item.source === "preinstall" || item.source === "store" || item.source === "import" ? item.source : "import";
    out.push({
      id,
      installedAt: asString(item.installedAt) ?? now,
      source,
      hidden: Boolean(item.hidden),
      pinnedToTaskbar: Boolean(item.pinnedToTaskbar),
    });
  }
  return out;
}

function normalizeFolders(raw: unknown): DesktopFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: DesktopFolder[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    const name = asString(item.name) ?? "文件夹";
    if (!id) continue;
    const appIds = Array.isArray(item.appIds) ? item.appIds.filter((x): x is string => typeof x === "string") : [];
    out.push({ id, name, appIds });
  }
  return out;
}

function normalizePlacements(raw: unknown): Placement[] {
  if (Array.isArray(raw)) {
    const out: Placement[] = [];
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const targetId = asString(item.targetId);
      if (!targetId) continue;
      const kind = item.kind === "folder" ? "folder" : "app";
      const col = typeof item.col === "number" ? item.col : 0;
      const row = typeof item.row === "number" ? item.row : 0;
      out.push({ targetId, kind, col, row, monitor: 0 });
    }
    return out;
  }
  // 喵咛：placements / desktopPositions 为对象 map
  if (isRecord(raw)) {
    const out: Placement[] = [];
    let i = 0;
    for (const [targetId, value] of Object.entries(raw)) {
      if (isRecord(value)) {
        const col = typeof value.col === "number" ? value.col : typeof value.x === "number" ? Math.round(Number(value.x) / 96) : 0;
        const row = typeof value.row === "number" ? value.row : typeof value.y === "number" ? Math.round(Number(value.y) / 96) : i;
        out.push({ targetId, kind: "app", col, row, monitor: 0 });
      } else {
        out.push({ targetId, kind: "app", col: 0, row: i, monitor: 0 });
      }
      i += 1;
    }
    return out;
  }
  return [];
}

function normalizePrefs(raw: unknown): DesktopPrefs {
  if (!isRecord(raw)) return { ...DEFAULT_DESKTOP_PREFS };
  const iconSize = raw.iconSize === "sm" || raw.iconSize === "lg" ? raw.iconSize : "md";
  const themeId = asString(raw.themeId) ?? DEFAULT_DESKTOP_PREFS.themeId;
  // 忽略喵咛 theme / wallpaperCharacter（禁会员锁主题包；M1 不映射付费皮）
  return { iconSize, themeId };
}

function normalizeTaskbar(raw: unknown): TaskbarState {
  if (!isRecord(raw)) return { ...DEFAULT_TASKBAR };
  const order = Array.isArray(raw.order) ? raw.order.filter((x): x is string => typeof x === "string") : [...DEFAULT_TASKBAR.order];
  return { order, showStore: true, showStart: true };
}

export function exportDesktopBackup(input: {
  installed: InstalledApp[];
  folders: DesktopFolder[];
  placements: Placement[];
  taskbar: TaskbarState;
  prefs: DesktopPrefs;
}): DesktopBackupV1 {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    schema: "toiv.desktop.v1",
    installed: input.installed,
    folders: input.folders,
    placements: input.placements,
    taskbar: input.taskbar,
    prefs: {
      iconSize: input.prefs.iconSize,
      themeId: input.prefs.themeId || DEFAULT_DESKTOP_PREFS.themeId,
    },
  };
}

export type ImportResult = {
  ok: true;
  kind: "toiv.desktop.v1" | "miorning98-desktop-backup" | "loose";
  installed: InstalledApp[];
  folders: DesktopFolder[];
  placements: Placement[];
  taskbar: TaskbarState;
  prefs: DesktopPrefs;
} | { ok: false; error: string };

/**
 * 宽松导入：
 * - toiv.desktop.v1
 * - 喵咛 miorning98-desktop-backup（state.installed string[] + folders + placements|desktopPositions）
 * 勿宣称 100% 字段兼容；忽略 pin / permanentAds / 会员主题。
 */
export function importDesktopBackup(raw: unknown): ImportResult {
  const now = new Date().toISOString();
  if (!isRecord(raw)) return { ok: false, error: "不是 JSON 对象" };

  // 喵咛实样
  if (raw.kind === "miorning98-desktop-backup" || isRecord(raw.state)) {
    const state = isRecord(raw.state) ? raw.state : raw;
    const installed = normalizeInstalled(state.installed, now).map((i) => ({
      ...i,
      source: "import" as const,
    }));
    const folders = normalizeFolders(state.folders);
    const placementsRaw = state.placements ?? state.desktopPositions ?? {};
    let placements = normalizePlacements(placementsRaw);
    if (placements.length === 0 && installed.length > 0) {
      placements = installed.map((item, index) => ({ targetId: item.id, kind: "app" as const, col: 0, row: index, monitor: 0 as const }));
    }
    return {
      ok: true,
      kind: "miorning98-desktop-backup",
      installed,
      folders,
      placements,
      taskbar: { ...DEFAULT_TASKBAR },
      prefs: normalizePrefs(state),
    };
  }

  // toiv.desktop.v1
  if (raw.schema === "toiv.desktop.v1" || raw.version === 1) {
    const installed = normalizeInstalled(raw.installed, now);
    const folders = normalizeFolders(raw.folders);
    const placements = normalizePlacements(raw.placements);
    return {
      ok: true,
      kind: "toiv.desktop.v1",
      installed,
      folders,
      placements,
      taskbar: normalizeTaskbar(raw.taskbar),
      prefs: normalizePrefs(raw.prefs),
    };
  }

  // loose：顶层 installed
  if (Array.isArray(raw.installed)) {
    return {
      ok: true,
      kind: "loose",
      installed: normalizeInstalled(raw.installed, now),
      folders: normalizeFolders(raw.folders),
      placements: normalizePlacements(raw.placements ?? raw.desktopPositions),
      taskbar: normalizeTaskbar(raw.taskbar),
      prefs: normalizePrefs(raw.prefs),
    };
  }

  return { ok: false, error: "无法识别的桌面备份格式" };
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function knownCatalogIds(): Set<string> {
  return new Set(DESKTOP_APP_CATALOG.map((a) => a.id));
}

export function filterInstallable(id: string): boolean {
  if (id.startsWith("wf:")) return false;
  return Boolean(getAppDef(id));
}
