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

/**
 * Studio 创作工作室项目状态管理。
 * - detail:项目详情(含角色 + 分镜),pid 变化自动重载
 * - busy:按操作 key 的进行中标记(渲染/配音/对口型/合成),供按钮禁用态
 * - 单镜操作成功后局部更新该镜,批量/合成后整体 refresh
 */
export function useStudioProject(pid: string | null) {
  const [detail, setDetail] = useState<StudioProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

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

  const withBusy = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await fn();
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }, []);

  const patchShotLocal = useCallback((shot: StudioShot) => {
    setDetail((d) =>
      d ? { ...d, shots: d.shots.map((s) => (s.id === shot.id ? shot : s)) } : d,
    );
  }, []);

  const saveShots = useCallback(
    async (shots: StudioShotInput[]) => {
      if (!pid) return;
      await saveStudioShots(pid, shots);
      await refresh();
    },
    [pid, refresh],
  );

  const renderShot = useCallback(
    (sid: string) =>
      withBusy(`render:${sid}`, async () => patchShotLocal(await renderStudioShot(sid))),
    [withBusy, patchShotLocal],
  );

  const renderAll = useCallback(
    () =>
      withBusy("render:all", async () => {
        if (pid) {
          await renderStudioAll(pid);
          await refresh();
        }
      }),
    [withBusy, pid, refresh],
  );

  const voiceShot = useCallback(
    (sid: string) =>
      withBusy(`voice:${sid}`, async () => patchShotLocal(await voiceStudioShot(sid))),
    [withBusy, patchShotLocal],
  );

  const lipsyncShot = useCallback(
    (sid: string) =>
      withBusy(`lipsync:${sid}`, async () => patchShotLocal(await lipsyncStudioShot(sid))),
    [withBusy, patchShotLocal],
  );

  const assemble = useCallback(
    () =>
      withBusy("assemble", async () => {
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
    refresh,
    saveShots,
    renderShot,
    renderAll,
    voiceShot,
    lipsyncShot,
    assemble,
  };
}
