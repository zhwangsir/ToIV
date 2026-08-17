"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getStudioProject,
  saveStudioShots,
  renderStudioShot,
  renderStudioAll,
  voiceStudioShot,
  lipsyncStudioShot,
  assembleStudio,
  type StudioProjectDetail,
  type StudioShot,
  type StudioShotInput,
} from "@/lib/api";
import { begin as genBegin, end as genEnd } from "@/lib/generationBus";

/**
 * Studio 创作工作室项目状态管理。
 * - detail:项目详情(含角色 + 分镜),pid 变化自动重载
 * - busy:按操作 key 的进行中标记(渲染/配音/对口型/合成),供按钮禁用态
 * - error:操作级报错(saveShots/渲染/配音/对口型/合成失败都会透出),
 *   由调用方渲染为可关闭提示条,clearError 关闭
 * - 单镜操作成功后局部更新该镜,批量/合成后整体 refresh
 */
/** 分镜失焦自动保存状态:idle / saving / saved / error(供 ShotCard 轻量指示) */
export type StudioSaveState = "idle" | "saving" | "saved" | "error";

export function useStudioProject(pid: string | null) {
  const [detail, setDetail] = useState<StudioProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [saveState, setSaveState] = useState<StudioSaveState>("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await getStudioProject(pid));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [pid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearError = useCallback(() => setError(null), []);

  // 操作统一入口:失败时把错误透出到 hook error(调用方渲染提示条),
  // 并继续 rethrow,保持调用方可编程感知(catch 后自行降级)。
  // 全局进度条:withBusy 是 render/voice/lipsync/assemble 唯一扼流点,
  // 在此统一登记/清除任务(label 即操作名,indeterminate)。
  const withBusy = useCallback(async (key: string, label: string, fn: () => Promise<void>) => {
    const taskId = `studio-${key}`;
    genBegin(taskId, label);
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await fn();
    } catch (e) {
      setError(`${label}失败:${e instanceof Error ? e.message : "未知错误"}`);
      throw e;
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
      genEnd(taskId);
    }
  }, []);

  const patchShotLocal = useCallback((shot: StudioShot) => {
    setDetail((d) =>
      d ? { ...d, shots: d.shots.map((s) => (s.id === shot.id ? shot : s)) } : d,
    );
  }, []);

  // 失焦自动保存:失败必须显式标记 error(分镜保存失败)并 rethrow;
  // 不静默 refresh,避免用服务端旧数据覆盖用户正在进行的本地编辑。
  const saveShots = useCallback(
    async (shots: StudioShotInput[]) => {
      if (!pid) return;
      setSaveState("saving");
      try {
        await saveStudioShots(pid, shots);
      } catch (e) {
        setSaveState("error");
        setError(`分镜保存失败,请重试或复制内容(${e instanceof Error ? e.message : "未知错误"})`);
        throw e;
      }
      setSaveState("saved");
      setSavedAt(new Date());
      await refresh();
    },
    [pid, refresh],
  );

  const renderShot = useCallback(
    (sid: string) =>
      withBusy(`render:${sid}`, "生成分镜", async () =>
        patchShotLocal(await renderStudioShot(sid)),
      ),
    [withBusy, patchShotLocal],
  );

  const renderAll = useCallback(
    () =>
      withBusy("render:all", "批量生成分镜", async () => {
        if (pid) {
          await renderStudioAll(pid);
          await refresh();
        }
      }),
    [withBusy, pid, refresh],
  );

  const voiceShot = useCallback(
    (sid: string) =>
      withBusy(`voice:${sid}`, "分镜配音", async () =>
        patchShotLocal(await voiceStudioShot(sid)),
      ),
    [withBusy, patchShotLocal],
  );

  const lipsyncShot = useCallback(
    (sid: string) =>
      withBusy(`lipsync:${sid}`, "分镜对口型", async () =>
        patchShotLocal(await lipsyncStudioShot(sid)),
      ),
    [withBusy, patchShotLocal],
  );

  const assemble = useCallback(
    () =>
      withBusy("assemble", "合成成片", async () => {
        if (pid) {
          await assembleStudio(pid);
          await refresh();
        }
      }),
    [withBusy, pid, refresh],
  );

  return {
    detail,
    loading,
    error,
    busy,
    saveState,
    savedAt,
    clearError,
    refresh,
    saveShots,
    renderShot,
    renderAll,
    voiceShot,
    lipsyncShot,
    assemble,
  };
}
