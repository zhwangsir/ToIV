"use client";

import type { ReactNode } from "react";

import type { CanvasNodeType, NodeRunState } from "../types";
import { NODE_META } from "../types";

interface NodeShellProps {
  type: CanvasNodeType;
  selected?: boolean;
  /** 运行态(图片/视频/音频节点有;文本节点不传)。 */
  run?: NodeRunState;
  onDelete: () => void;
  /** 主操作(生成按钮等)放标题栏右侧;为空则不渲染。 */
  action?: ReactNode;
  children: ReactNode;
}

/** 节点统一外壳:标题栏 + 删除 + 进度/错误条 + body 容器。
 *  端口(Handle)由各节点自行渲染,因为入/出口语义不同。 */
export function NodeShell({
  type,
  selected,
  run,
  onDelete,
  action,
  children,
}: NodeShellProps) {
  const meta = NODE_META[type];
  return (
    <div
      className={`cv-node cv-node--${type}${selected ? " is-selected" : ""}${
        run?.busy ? " is-busy" : ""
      }`}
    >
      <header className="cv-node__bar">
        <span className="cv-node__title">
          <span className="cv-node__ico" aria-hidden="true">
            {meta.icon}
          </span>
          {meta.label}
        </span>
        {action}
        <button
          type="button"
          className="cv-node__del nodrag"
          onClick={onDelete}
          aria-label={`删除${meta.label}节点`}
          title="删除节点"
        >
          ✕
        </button>
      </header>

      {run && (run.busy || run.error) && (
        <div className="cv-node__status" role="status">
          {run.error ? (
            <span className="cv-node__err">{run.error}</span>
          ) : (
            <>
              <span className="cv-node__stage">{run.stage || "处理中…"}</span>
              <div
                className={`cv-progress${run.progress === null ? " is-indeterminate" : ""}`}
                aria-hidden="true"
              >
                <span
                  className="cv-progress__fill"
                  style={
                    run.progress === null
                      ? undefined
                      : { width: `${run.progress}%` }
                  }
                />
              </div>
            </>
          )}
        </div>
      )}

      <div className="cv-node__body">{children}</div>
    </div>
  );
}
