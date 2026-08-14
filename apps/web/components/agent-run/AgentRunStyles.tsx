"use client";

/**
 * Agent Team 模块全部样式(全局,覆盖列表页与详情页):Film Atelier 变量体系,
 * 克制动效(仅 fast 档 hover/过渡),错误条沿用 .studio-error 同构范式。
 */
export function AgentRunStyles() {
  return (
    <style jsx global>{`
      /* ── 独立路由页壳:无 app-shell,自带画布底与居中列 ── */
      .agent-page {
        min-height: 100dvh;
        background: var(--bg-canvas);
        color: var(--text-primary);
      }
      .agent-shell {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
        width: 100%;
        max-width: 1200px;
        margin: 0 auto;
        padding: var(--space-8);
      }

      /* ── 顶栏:吸附,返回 + 目标 + 徽章 + 操作 ── */
      .agent-topbar {
        position: sticky;
        top: 0;
        z-index: var(--z-sticky);
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) 0 var(--space-3);
        background: var(--bg-canvas);
        border-bottom: 1px solid var(--border-subtle);
      }
      .agent-back {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-aux);
        color: var(--text-muted);
        text-decoration: none;
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-control);
        white-space: nowrap;
        flex-shrink: 0;
        transition:
          color var(--duration-fast) var(--ease-standard),
          background-color var(--duration-fast) var(--ease-standard);
      }
      .agent-back:hover {
        color: var(--text-primary);
        background: var(--bg-surface-2);
      }
      .agent-topbar-main {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
      }
      .agent-goal {
        margin: 0;
        font-size: var(--text-section);
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .agent-topbar-meta {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-shrink: 0;
      }
      .agent-topbar-actions {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-shrink: 0;
      }
      .agent-mode {
        display: flex;
        gap: var(--space-1);
        background: var(--bg-surface-2);
        padding: var(--space-1);
        border-radius: var(--radius-control);
      }
      .agent-mode-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        color: var(--text-muted);
        background: none;
        border: none;
        border-radius: calc(var(--radius-control) - 4px);
        cursor: pointer;
        transition:
          color var(--duration-fast) var(--ease-standard),
          background-color var(--duration-fast) var(--ease-standard);
      }
      .agent-mode-btn.is-active {
        color: var(--accent);
        background: var(--bg-surface-1);
        box-shadow: var(--shadow-sm);
      }

      /* ── 状态徽章(任务/run 共用,tone 语义色) ── */
      .agent-status {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-label);
        font-weight: 500;
        padding: 2px var(--space-2);
        border-radius: var(--radius-badge);
        white-space: nowrap;
      }
      .agent-status.is-neutral {
        color: var(--text-secondary);
        background: var(--bg-surface-2);
      }
      .agent-status.is-accent {
        color: var(--accent);
        background: var(--accent-soft);
      }
      .agent-status.is-ok {
        color: var(--ok);
        background: var(--ok-soft);
      }
      .agent-status.is-warn {
        color: var(--warn);
        background: var(--warn-soft);
      }
      .agent-status.is-err {
        color: var(--err);
        background: var(--err-soft);
      }

      /* ── 错误条(.studio-error 同构,可关闭) ── */
      .agent-error {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin: 0;
        font-size: var(--text-aux);
        color: var(--err);
        background: var(--err-soft);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
        padding: var(--space-2) var(--space-3);
      }
      .agent-error-text {
        flex: 1;
        min-width: 0;
      }
      .agent-error-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        flex-shrink: 0;
        color: var(--err);
        background: none;
        border: none;
        border-radius: var(--radius-control);
        cursor: pointer;
        transition: background-color var(--duration-fast) var(--ease-standard);
      }
      .agent-error-close:hover {
        background: var(--bg-surface-2);
      }

      /* ── 连接态横幅(断线重连/降级轮询) ── */
      .agent-conn {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin: 0;
        font-size: var(--text-aux);
        color: var(--warn);
        background: var(--warn-soft);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
        padding: var(--space-2) var(--space-3);
      }

      /* ── 秒回横幅 ── */
      .agent-ack {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--accent-soft);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
      }
      .agent-ack-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        color: var(--accent);
        background: var(--bg-surface-1);
        border-radius: 50%;
      }
      .agent-ack-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .agent-ack-title {
        font-size: var(--text-aux);
        font-weight: 600;
        color: var(--text-primary);
      }
      .agent-ack-sub {
        font-size: var(--text-label);
        color: var(--text-muted);
      }

      /* ── 主区布局:卡片/泳道 + 右侧事件流;窄屏堆叠 ── */
      .agent-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 300px;
        gap: var(--space-5);
        align-items: start;
      }
      .agent-main {
        min-width: 0;
      }

      /* ── 任务卡片流 ── */
      .agent-task-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: var(--space-3);
      }
      .agent-task {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
        overflow: hidden;
        transition: border-color var(--duration-fast) var(--ease-standard);
      }
      .agent-task:hover {
        border-color: var(--border-strong);
      }
      .agent-task[data-status="error"],
      .agent-task[data-status="error"]:hover {
        border-color: var(--err);
      }
      .agent-task-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-3) 0;
      }
      .agent-task-idx {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        font-size: var(--text-label);
        font-weight: 600;
        color: var(--text-muted);
        background: var(--bg-surface-2);
        border-radius: 50%;
      }
      .agent-task-kind {
        font-size: var(--text-label);
        font-weight: 500;
        color: var(--accent);
        background: var(--accent-soft);
        padding: 1px var(--space-2);
        border-radius: var(--radius-badge);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .agent-task-title {
        flex: 1;
        min-width: 0;
        margin: 0;
        font-size: var(--text-aux);
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agent-attempt {
        font-size: var(--text-label);
        color: var(--warn);
        background: var(--warn-soft);
        padding: 1px var(--space-2);
        border-radius: var(--radius-badge);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .agent-task-deps {
        margin: 0;
        padding: 0 var(--space-3);
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .agent-task-media {
        position: relative;
        aspect-ratio: 16 / 9;
        margin: 0 var(--space-3);
        background: var(--bg-surface-2);
        border-radius: var(--radius-control);
        overflow: hidden;
      }
      .agent-task-media video,
      .agent-task-media img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .agent-task-audio {
        width: 100%;
        margin-top: var(--space-6);
      }
      .agent-task-text {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: var(--space-2);
        font-size: var(--text-label);
        color: var(--text-secondary);
        overflow: auto;
        white-space: pre-wrap;
      }
      .agent-task-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--space-1);
        width: 100%;
        height: 100%;
        color: var(--text-muted);
        font-size: var(--text-label);
      }
      .agent-task-error {
        margin: 0 var(--space-3);
        font-size: var(--text-label);
        color: var(--err);
      }
      .agent-task-verdict {
        margin: 0 var(--space-3);
        font-size: var(--text-label);
        color: var(--warn);
      }
      .agent-gpu {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        margin: 0 var(--space-3);
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .agent-task-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3) var(--space-3);
        border-top: 1px solid var(--border-subtle);
        margin-top: var(--space-1);
      }
      .agent-task-edit {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: 0 var(--space-3) var(--space-3);
      }
      .agent-task-edit-actions {
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
      }

      /* ── 计划确认门 ── */
      .agent-plan {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
      }
      .agent-plan-head {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .agent-plan-title {
        margin: 0;
        font-size: var(--text-section);
        font-weight: 600;
      }
      .agent-plan-desc {
        margin: 0;
        font-size: var(--text-aux);
        color: var(--text-muted);
      }
      .agent-plan-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .agent-plan-item {
        display: flex;
        gap: var(--space-3);
        padding: var(--space-3);
        background: var(--bg-surface-2);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
      }
      .agent-plan-item.is-new {
        border-style: dashed;
      }
      .agent-plan-idx {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        flex-shrink: 0;
        font-size: var(--text-label);
        font-weight: 600;
        color: var(--text-muted);
        background: var(--bg-surface-1);
        border-radius: 50%;
      }
      .agent-plan-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .agent-plan-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .agent-plan-title-input {
        flex: 1;
        min-width: 0;
      }
      .agent-plan-del {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        flex-shrink: 0;
        color: var(--text-muted);
        background: none;
        border: none;
        border-radius: var(--radius-control);
        cursor: pointer;
        transition:
          color var(--duration-fast) var(--ease-standard),
          background-color var(--duration-fast) var(--ease-standard);
      }
      .agent-plan-del:hover {
        color: var(--err);
        background: var(--bg-surface-1);
      }
      .agent-plan-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .agent-plan-actions-gap {
        flex: 1;
      }
      .agent-plan-feedback {
        flex: 1;
        min-width: 200px;
      }

      /* ── 合成确认门时间线 ── */
      .agent-gate-desc {
        margin: 0 0 var(--space-3);
        font-size: var(--text-aux);
        color: var(--text-muted);
      }
      .agent-gate-timeline {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        list-style: none;
        margin: 0 0 var(--space-3);
        padding: 0;
      }
      .agent-gate-item {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-3);
        background: var(--bg-surface-2);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
      }
      .agent-gate-idx {
        font-size: var(--text-label);
        font-weight: 600;
        color: var(--text-muted);
        width: 16px;
        text-align: center;
        flex-shrink: 0;
      }
      .agent-gate-title {
        flex: 1;
        min-width: 0;
        font-size: var(--text-aux);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agent-gate-dur {
        font-size: var(--text-label);
        color: var(--text-muted);
        flex-shrink: 0;
      }
      .agent-gate-total {
        margin: 0;
        font-size: var(--text-aux);
        color: var(--text-secondary);
      }

      /* ── 泳道流水线 ── */
      .agent-lanes {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .agent-lane {
        display: grid;
        grid-template-columns: 64px minmax(0, 1fr);
        gap: var(--space-3);
        align-items: start;
        padding: var(--space-2);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
      }
      .agent-lane-label {
        font-size: var(--text-label);
        font-weight: 600;
        color: var(--text-muted);
        padding-top: var(--space-2);
        text-align: center;
      }
      .agent-lane-nodes {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .agent-node {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        max-width: 240px;
        padding: var(--space-1) var(--space-2);
        background: var(--bg-surface-2);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
        font-size: var(--text-label);
      }
      .agent-node[data-status="running"] {
        border-color: var(--accent);
      }
      .agent-node[data-status="done"],
      .agent-node[data-status="approved"] {
        border-color: var(--ok);
      }
      .agent-node[data-status="error"],
      .agent-node[data-status="rejected"] {
        border-color: var(--err);
      }
      .agent-node-idx {
        color: var(--text-muted);
        font-weight: 600;
      }
      .agent-node-icon.is-accent {
        color: var(--accent);
      }
      .agent-node-icon.is-ok {
        color: var(--ok);
      }
      .agent-node-icon.is-err {
        color: var(--err);
      }
      .agent-node-icon.is-warn {
        color: var(--warn);
      }
      .agent-node-icon.is-neutral {
        color: var(--text-muted);
      }
      .agent-node-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .agent-node-deps {
        color: var(--text-muted);
        flex-shrink: 0;
      }

      /* ── 事件汇报流(右栏) ── */
      .agent-ticker {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
        max-height: 70vh;
        overflow-y: auto;
      }
      .agent-ticker-title {
        margin: 0;
        font-size: var(--text-aux);
        font-weight: 600;
      }
      .agent-ticker-empty {
        margin: 0;
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .agent-ticker-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .agent-ticker-item {
        display: flex;
        align-items: flex-start;
        gap: var(--space-2);
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-control);
        font-size: var(--text-label);
        color: var(--text-secondary);
      }
      .agent-ticker-icon {
        flex-shrink: 0;
        margin-top: 2px;
      }
      .agent-ticker-item.is-start .agent-ticker-icon {
        color: var(--accent);
      }
      .agent-ticker-item.is-blocked .agent-ticker-icon {
        color: var(--warn);
      }
      .agent-ticker-item.is-decision .agent-ticker-icon {
        color: var(--warn);
      }
      .agent-ticker-item.is-done .agent-ticker-icon {
        color: var(--ok);
      }
      .agent-ticker-item.is-error .agent-ticker-icon {
        color: var(--err);
      }
      .agent-ticker-item.is-info .agent-ticker-icon {
        color: var(--text-muted);
      }
      .agent-ticker-text {
        flex: 1;
        min-width: 0;
      }
      .agent-ticker-tone {
        color: var(--text-muted);
        margin-right: var(--space-1);
      }
      .agent-ticker-time {
        flex-shrink: 0;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }

      /* ── 成片 ── */
      .agent-final {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
      }
      .agent-final-title {
        margin: 0;
        font-size: var(--text-section);
        font-weight: 600;
      }
      .agent-final-player {
        width: 100%;
        max-width: 720px;
        border-radius: var(--radius-control);
        background: var(--bg-surface-2);
      }

      /* ── 列表页 ── */
      .agent-page-title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .agent-goal-box {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-5);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
      }
      .agent-goal-input {
        min-height: 120px;
        font-size: var(--text-base);
      }
      .agent-goal-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .agent-goal-hint {
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .agent-l0 {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--ok-soft);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
        font-size: var(--text-aux);
      }
      .agent-l0-text {
        flex: 1;
        min-width: 0;
      }
      .agent-l0-link {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        color: var(--accent);
        font-weight: 500;
        text-decoration: none;
        white-space: nowrap;
      }
      .agent-l0-link:hover {
        text-decoration: underline;
      }
      .agent-run-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        max-width: 800px;
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .agent-run-open {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
        cursor: pointer;
        text-align: left;
        transition:
          border-color var(--duration-fast) var(--ease-standard),
          box-shadow var(--duration-fast) var(--ease-standard),
          transform var(--duration-fast) var(--ease-standard);
      }
      .agent-run-open:hover {
        border-color: var(--border-strong);
        box-shadow: var(--shadow-md);
        transform: translateY(-2px);
      }
      .agent-run-goal {
        font-size: var(--text-aux);
        font-weight: 600;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agent-run-meta {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        font-size: var(--text-label);
        color: var(--text-muted);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .agent-run-progress {
        font-variant-numeric: tabular-nums;
      }
      .agent-section-title {
        margin: 0;
        font-size: var(--text-section);
        font-weight: 600;
      }

      /* ── 窄屏 <1024px:事件流落到底部 ── */
      @media (max-width: 1023px) {
        .agent-shell {
          padding: var(--space-5);
        }
        .agent-layout {
          grid-template-columns: minmax(0, 1fr);
        }
        .agent-ticker {
          max-height: 320px;
        }
      }

      /* ── 移动 <768px:触控目标 ≥44px ── */
      @media (max-width: 767px) {
        .agent-shell {
          padding: var(--space-4);
        }
        .agent-topbar {
          flex-wrap: wrap;
        }
        .agent-topbar-main {
          order: 3;
          flex-basis: 100%;
        }
        .agent-back,
        .agent-mode-btn {
          min-height: 44px;
        }
        .agent-mode-btn {
          width: 44px;
        }
        .agent-task-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }

      @media (max-width: 575px) {
        .agent-shell {
          padding: var(--space-3);
        }
        .agent-lane {
          grid-template-columns: 48px minmax(0, 1fr);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .agent-run-open,
        .agent-task,
        .agent-back,
        .agent-mode-btn,
        .agent-plan-del,
        .agent-error-close {
          transition: none;
        }
      }
    `}</style>
  );
}
