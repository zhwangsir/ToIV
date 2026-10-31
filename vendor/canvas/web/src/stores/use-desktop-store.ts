import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  buildDefaultInstalled,
  buildDefaultPlacements,
  DEFAULT_DESKTOP_PREFS,
  DEFAULT_TASKBAR,
  getAppDef,
  resolveAppIdByPath,
} from "@/lib/desktop/catalog";
import { exportDesktopBackup, importDesktopBackup, type ImportResult } from "@/lib/desktop/backup";
import type {
  DesktopBackupV1,
  DesktopFolder,
  DesktopPrefs,
  InstalledApp,
  Placement,
  SessionWindows,
  TaskbarState,
  WindowBounds,
  WindowInstance,
  WindowState,
} from "@/lib/desktop/types";

export const DESKTOP_STORE_KEY = "toiv:desktop:v1";

/** M2.1：打开被拒时的瞬时提示（不持久化） */
export type DesktopNotice = {
  kind: "not_installed";
  appId: string;
  message: string;
};

type DesktopStore = {
  hydrated: boolean;
  installed: InstalledApp[];
  folders: DesktopFolder[];
  placements: Placement[];
  taskbar: TaskbarState;
  prefs: DesktopPrefs;
  windows: SessionWindows;
  startOpen: boolean;
  /** 未安装深链/打开拒装回时的 toast 文案 */
  notice: DesktopNotice | null;
  setStartOpen: (open: boolean) => void;
  clearNotice: () => void;
  installApp: (id: string) => void;
  uninstallApp: (id: string) => void;
  /** 成功返回 instanceId；可卸未装返回 null（不静默装回） */
  openApp: (appId: string, entry?: string) => string | null;
  focusWindow: (instanceId: string) => void;
  minimizeWindow: (instanceId: string) => void;
  maximizeWindow: (instanceId: string) => void;
  restoreWindow: (instanceId: string) => void;
  closeWindow: (instanceId: string) => void;
  setWindowBounds: (instanceId: string, bounds: WindowBounds) => void;
  exportBackup: () => DesktopBackupV1;
  importBackup: (raw: unknown) => ImportResult;
  resetToFactory: () => void;
};

function now() {
  return new Date().toISOString();
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function nextZ(stack: WindowInstance[]) {
  return stack.reduce((m, w) => Math.max(m, w.z), 0) + 1;
}

function defaultBounds(index: number): WindowBounds {
  const offset = (index % 4) * 28;
  return { x: 48 + offset, y: 36 + offset, w: 1080, h: 640 };
}

function factoryState() {
  const installed = buildDefaultInstalled();
  return {
    installed,
    folders: [] as DesktopFolder[],
    placements: buildDefaultPlacements(installed),
    taskbar: { ...DEFAULT_TASKBAR },
    prefs: { ...DEFAULT_DESKTOP_PREFS },
    windows: { stack: [] as WindowInstance[], focusedId: null as string | null },
  };
}

export const useDesktopStore = create<DesktopStore>()(
  persist(
    (set, get) => ({
      hydrated: false,
      ...factoryState(),
      startOpen: false,
      notice: null,
      setStartOpen: (open) => set({ startOpen: open }),
      clearNotice: () => set({ notice: null }),

      installApp: (id) => {
        const def = getAppDef(id);
        if (!def) return;
        set((state) => {
          if (state.installed.some((i) => i.id === id && !i.hidden)) return state;
          const existing = state.installed.find((i) => i.id === id);
          let installed: InstalledApp[];
          if (existing) {
            installed = state.installed.map((i) =>
              i.id === id ? { ...i, hidden: false, source: i.source === "preinstall" ? i.source : "store" } : i,
            );
          } else {
            installed = [...state.installed, { id, installedAt: now(), source: "store", pinnedToTaskbar: false }];
          }
          const hasPlacement = state.placements.some((p) => p.targetId === id);
          const placements = hasPlacement
            ? state.placements
            : [
                ...state.placements,
                { targetId: id, kind: "app" as const, col: 0, row: state.placements.length, monitor: 0 as const },
              ];
          return { installed, placements };
        });
      },

      uninstallApp: (id) => {
        const def = getAppDef(id);
        if (!def) return;
        set((state) => {
          const stack = state.windows.stack.filter((w) => w.appId !== id);
          const lostFocus = state.windows.stack.some(
            (w) => w.appId === id && w.instanceId === state.windows.focusedId,
          );
          const stripWindow = {
            stack,
            focusedId: lostFocus
              ? [...stack].filter((w) => w.state !== "minimized").sort((a, b) => b.z - a.z)[0]?.instanceId ?? null
              : state.windows.focusedId,
          };
          if (def.system) {
            return {
              installed: state.installed.map((i) => (i.id === id ? { ...i, hidden: true, pinnedToTaskbar: false } : i)),
              placements: state.placements.filter((p) => p.targetId !== id),
              folders: state.folders.map((f) => ({ ...f, appIds: f.appIds.filter((a) => a !== id) })),
              taskbar: { ...state.taskbar, order: state.taskbar.order.filter((x) => x !== id) },
              windows: stripWindow,
            };
          }
          return {
            installed: state.installed.filter((i) => i.id !== id),
            placements: state.placements.filter((p) => p.targetId !== id),
            folders: state.folders.map((f) => ({ ...f, appIds: f.appIds.filter((a) => a !== id) })),
            taskbar: { ...state.taskbar, order: state.taskbar.order.filter((x) => x !== id) },
            windows: stripWindow,
          };
        });
      },

      openApp: (appId, entry) => {
        const def = getAppDef(appId);
        if (!def) return null;
        const installed = get().installed.find((i) => i.id === appId);
        // M2.1：可卸且不在 installed → 禁止静默装回（深链/侧栏/openApp 同口径）
        if (!def.system && !installed) {
          set({
            notice: {
              kind: "not_installed",
              appId,
              message: `「${def.name}」未安装`,
            },
          });
          return null;
        }
        // M2.1 system+hidden：选定 A — 取消 hidden 再开（installApp 会 unhide）
        if (def.system && (!installed || installed.hidden)) {
          get().installApp(appId);
        }
        const targetEntry = entry ?? def.entry;
        set((state) => {
          const existing = state.windows.stack.find((w) => w.appId === appId);
          if (existing) {
            return {
              windows: {
                stack: state.windows.stack.map((w) =>
                  w.instanceId === existing.instanceId
                    ? {
                        ...w,
                        state: "normal" as WindowState,
                        entry: targetEntry,
                        z: nextZ(state.windows.stack),
                        title: def.name,
                      }
                    : w,
                ),
                focusedId: existing.instanceId,
              },
              startOpen: false,
            };
          }
          const instanceId = uid(appId);
          const win: WindowInstance = {
            instanceId,
            appId,
            entry: targetEntry,
            state: "normal",
            bounds: defaultBounds(state.windows.stack.length),
            z: nextZ(state.windows.stack),
            title: def.name,
          };
          return {
            windows: { stack: [...state.windows.stack, win], focusedId: instanceId },
            startOpen: false,
          };
        });
        return get().windows.stack.find((w) => w.appId === appId)?.instanceId ?? null;
      },

      focusWindow: (instanceId) =>
        set((state) => ({
          windows: {
            stack: state.windows.stack.map((w) =>
              w.instanceId === instanceId
                ? { ...w, state: w.state === "minimized" ? ("normal" as WindowState) : w.state, z: nextZ(state.windows.stack) }
                : w,
            ),
            focusedId: instanceId,
          },
        })),

      minimizeWindow: (instanceId) =>
        set((state) => {
          const stack = state.windows.stack.map((w) =>
            w.instanceId === instanceId ? { ...w, state: "minimized" as WindowState } : w,
          );
          const nextFocus =
            [...stack].filter((w) => w.state !== "minimized").sort((a, b) => b.z - a.z)[0]?.instanceId ?? null;
          return { windows: { stack, focusedId: nextFocus } };
        }),

      maximizeWindow: (instanceId) =>
        set((state) => ({
          windows: {
            stack: state.windows.stack.map((w) =>
              w.instanceId === instanceId
                ? { ...w, state: "maximized" as WindowState, z: nextZ(state.windows.stack) }
                : w,
            ),
            focusedId: instanceId,
          },
        })),

      restoreWindow: (instanceId) =>
        set((state) => ({
          windows: {
            stack: state.windows.stack.map((w) =>
              w.instanceId === instanceId ? { ...w, state: "normal" as WindowState, z: nextZ(state.windows.stack) } : w,
            ),
            focusedId: instanceId,
          },
        })),

      closeWindow: (instanceId) =>
        set((state) => {
          const stack = state.windows.stack.filter((w) => w.instanceId !== instanceId);
          const focusedId =
            state.windows.focusedId === instanceId
              ? [...stack].filter((w) => w.state !== "minimized").sort((a, b) => b.z - a.z)[0]?.instanceId ?? null
              : state.windows.focusedId;
          return { windows: { stack, focusedId } };
        }),

      setWindowBounds: (instanceId, bounds) =>
        set((state) => ({
          windows: {
            ...state.windows,
            stack: state.windows.stack.map((w) => (w.instanceId === instanceId ? { ...w, bounds } : w)),
          },
        })),

      exportBackup: () => {
        const s = get();
        return exportDesktopBackup({
          installed: s.installed,
          folders: s.folders,
          placements: s.placements,
          taskbar: s.taskbar,
          prefs: s.prefs,
        });
      },

      importBackup: (raw) => {
        const result = importDesktopBackup(raw);
        if (!result.ok) return result;
        set({
          installed: result.installed,
          folders: result.folders,
          placements: result.placements.length ? result.placements : buildDefaultPlacements(result.installed),
          taskbar: result.taskbar,
          prefs: result.prefs,
        });
        return result;
      },

      resetToFactory: () => set({ ...factoryState(), startOpen: false }),
    }),
    {
      name: DESKTOP_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        installed: state.installed,
        folders: state.folders,
        placements: state.placements,
        taskbar: state.taskbar,
        prefs: state.prefs,
        windows: state.windows,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          if (!state.prefs?.themeId) {
            state.prefs = { ...DEFAULT_DESKTOP_PREFS, ...(state.prefs ?? {}), themeId: DEFAULT_DESKTOP_PREFS.themeId };
          }
          useDesktopStore.setState({ hydrated: true });
        } else {
          useDesktopStore.setState({ hydrated: true });
        }
      },
    },
  ),
);

export type SyncDesktopRouteResult =
  | { status: "noop" }
  | { status: "focused"; appId: string }
  | { status: "opened"; appId: string; instanceId: string }
  | { status: "denied"; appId: string; reason: "not_installed" };

/** M2/M2.1 深链：URL → 窗态单例聚焦；可卸未装不装回，返回 denied 供壳跳转应用商店 */
export function syncDesktopRoute(pathname: string, search = ""): SyncDesktopRouteResult {
  const appId = resolveAppIdByPath(pathname);
  if (!appId) return { status: "noop" };
  const store = useDesktopStore.getState();
  const entry = `${pathname}${search || ""}`;
  const existing = store.windows.stack.find((w) => w.appId === appId);
  if (existing) {
    const already =
      existing.instanceId === store.windows.focusedId &&
      existing.state !== "minimized" &&
      existing.entry === entry;
    if (already) return { status: "focused", appId };
    useDesktopStore.setState((state) => ({
      windows: {
        stack: state.windows.stack.map((w) =>
          w.instanceId === existing.instanceId
            ? {
                ...w,
                entry,
                state: w.state === "minimized" ? ("normal" as WindowState) : w.state,
                z: nextZ(state.windows.stack),
                title: getAppDef(appId)?.name ?? w.title,
              }
            : w,
        ),
        focusedId: existing.instanceId,
      },
    }));
    return { status: "focused", appId };
  }
  const instanceId = store.openApp(appId, entry);
  if (!instanceId) {
    return { status: "denied", appId, reason: "not_installed" };
  }
  return { status: "opened", appId, instanceId };
}

/** 是否已安装且未隐藏（桌面图标 / 任务栏钉选可见性） */
export function isDesktopAppVisible(appId: string): boolean {
  const row = useDesktopStore.getState().installed.find((i) => i.id === appId);
  return Boolean(row && !row.hidden);
}
