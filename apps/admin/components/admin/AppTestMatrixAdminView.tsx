"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { Icon } from "@/components/ui/Icon";

/** 实测矩阵占位:P0 L0 本地快照 550/550;L2 尚未接远程。 */
export function AppTestMatrixAdminView() {
  return (
    <div className="admin-matrix">
      <PageHeader
        title="实测矩阵"
        desc="应用分级实测总览 · 当前为骨架占位"
      />
      <div className="admin-matrix-card at-card">
        <div className="admin-matrix-row">
          <Icon name="grid" size={18} />
          <div>
            <div className="admin-matrix-title">L0 结构扫描</div>
            <div className="admin-matrix-body">
              本地快照：公开目录 <strong>550 / 550</strong> 通过（schema/bindings
              结构；无 GPU 提交）。真源见
              <code>.regen_tmp/app_test_matrix_p0/</code>。
            </div>
          </div>
        </div>
        <div className="admin-matrix-row">
          <Icon name="zap" size={18} />
          <div>
            <div className="admin-matrix-title">L2 热路径冒烟</div>
            <div className="admin-matrix-body">
              <strong>待接入</strong> — 本页尚不能读取远程实测结果；候选清单见
              <code>l2_hotpath_candidates.json</code>。
            </div>
          </div>
        </div>
        <p className="admin-matrix-note">
          后续可将 L0/L2 汇总 API 挂到此页；当前仅展示占位文案，避免误读为实时数据。
        </p>
      </div>
      <style jsx>{`
        .admin-matrix-card {
          padding: var(--space-4);
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        .admin-matrix-row {
          display: flex;
          gap: var(--space-3);
          align-items: flex-start;
        }
        .admin-matrix-title {
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 4px;
        }
        .admin-matrix-body {
          color: var(--text-secondary);
          font-size: var(--text-body);
          line-height: 1.55;
        }
        .admin-matrix-body code {
          font-size: var(--text-caption);
        }
        .admin-matrix-note {
          margin: 0;
          color: var(--text-tertiary);
          font-size: var(--text-caption);
        }
      `}</style>
    </div>
  );
}
