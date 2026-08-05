"use client";

import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";

/**
 * 阶段把关(Stage Gate):每个创作环节需人工确认后方可进入下一环节,
 * 保证质量可控、每个环节都有人工把关和参与。
 *
 * 状态按项目持久化到 localStorage(纯前端工作流标记,不改后端契约):
 *   key = toiv.stageGate.{projectId} → { [stage]: approvedAtTs }
 */

export type StageGateKey =
  | "script"
  | "character"
  | "asset"
  | "shot"
  | "assemble"
  | "process"
  | "data";

type GateMap = Partial<Record<StageGateKey, number>>;

function storageKey(projectId: string): string {
  return `toiv.stageGate.${projectId}`;
}

function readGates(projectId: string): GateMap {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as GateMap) : {};
  } catch {
    return {};
  }
}

export interface UseStageGateReturn {
  /** 已把关的阶段 → 确认时间戳 */
  gates: GateMap;
  /** 某阶段是否已把关 */
  isApproved: (key: StageGateKey) => boolean;
  /** 确认通过(人工把关) */
  approve: (key: StageGateKey) => void;
  /** 撤销把关(需返工时) */
  revoke: (key: StageGateKey) => void;
  /** 已把关数量(用于整体进度提示) */
  approvedCount: number;
}

export function useStageGate(
  projectId: string | null | undefined,
): UseStageGateReturn {
  const [gates, setGates] = useState<GateMap>({});

  // 项目切换时加载对应把关状态
  useEffect(() => {
    if (!projectId) {
      setGates({});
      return;
    }
    setGates(readGates(projectId));
  }, [projectId]);

  const persist = useCallback(
    (next: GateMap) => {
      setGates(next);
      if (!projectId) return;
      try {
        localStorage.setItem(storageKey(projectId), JSON.stringify(next));
      } catch {
        // 存储失败(隐私模式/配额)不阻塞交互
      }
    },
    [projectId],
  );

  const approve = useCallback(
    (key: StageGateKey) => {
      persist({ ...gates, [key]: Date.now() });
    },
    [gates, persist],
  );

  const revoke = useCallback(
    (key: StageGateKey) => {
      const next = { ...gates };
      delete next[key];
      persist(next);
    },
    [gates, persist],
  );

  const isApproved = useCallback(
    (key: StageGateKey) => Boolean(gates[key]),
    [gates],
  );

  return {
    gates,
    isApproved,
    approve,
    revoke,
    approvedCount: Object.keys(gates).length,
  };
}

interface StageGateBarProps {
  stageKey: StageGateKey;
  stageLabel: string;
  gate: UseStageGateReturn;
  /** 把关前的就绪提示(如「剧本尚未填写」);为空表示已就绪可把关 */
  readyHint?: string;
}

/**
 * 阶段把关条:渲染在工作台主面板顶部,显示当前阶段把关状态,
 * 提供「确认通过」(二次确认)与「撤销把关」操作。
 */
export function StageGateBar({
  stageKey,
  stageLabel,
  gate,
  readyHint,
}: StageGateBarProps) {
  const [confirming, setConfirming] = useState(false);
  const approved = gate.isApproved(stageKey);

  // 切换阶段时重置二次确认态
  useEffect(() => {
    setConfirming(false);
  }, [stageKey]);

  const handleApprove = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 5000);
      return;
    }
    setConfirming(false);
    gate.approve(stageKey);
  };

  return (
    <div
      className={`ds-gate-bar${approved ? " ds-gate-approved" : ""}`}
      role="status"
    >
      <div className="ds-gate-info">
        <Icon
          name={approved ? "success" : "warning"}
          size={13}
          strokeWidth={1.9}
        />
        <span className="ds-gate-text">
          {approved
            ? `「${stageLabel}」已把关`
            : `「${stageLabel}」待把关`}
        </span>
        {!approved && readyHint && (
          <span className="ds-gate-hint">{readyHint}</span>
        )}
      </div>
      <div className="ds-gate-actions">
        {approved ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => gate.revoke(stageKey)}
            title="撤销把关,返工本环节"
          >
            <Icon name="refresh" size={12} />
            撤销把关
          </button>
        ) : (
          <button
            type="button"
            className={`btn btn-sm ${confirming ? "btn-primary" : "btn-ghost"}`}
            onClick={handleApprove}
            disabled={Boolean(readyHint)}
            title={readyHint ?? "人工确认本环节质量,通过后进入下一环节"}
          >
            <Icon name="check" size={12} />
            {confirming ? "确认通过?" : "把关通过"}
          </button>
        )}
      </div>
    </div>
  );
}
