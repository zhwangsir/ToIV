"use client";

/**
 * 事件汇报流(EventTicker):四态(开始/阻塞/需决策/完成)+ plan/verdict,
 * 时间倒序(hook 侧已按新→旧 prepend)。图标一律经 ui/Icon。
 */
import { Icon, type IconName } from "@/components/ui/Icon";
import type { AgentRunEventItem } from "./useAgentRun";

const TONE_ICON: Record<AgentRunEventItem["tone"], IconName> = {
  start: "play",
  blocked: "warning",
  decision: "hand",
  done: "success",
  info: "info",
  error: "x-circle",
};

const TONE_LABEL: Record<AgentRunEventItem["tone"], string> = {
  start: "开始",
  blocked: "阻塞",
  decision: "需决策",
  done: "完成",
  info: "汇报",
  error: "出错",
};

export function EventTicker({ events }: { events: AgentRunEventItem[] }) {
  return (
    <aside className="agent-ticker" aria-label="事件汇报流">
      <h2 className="agent-ticker-title">事件汇报</h2>
      {events.length === 0 ? (
        <p className="agent-ticker-empty">暂无事件,任务动态会实时出现在这里</p>
      ) : (
        <ul className="agent-ticker-list">
          {events.map((ev) => {
            return (
              <li key={ev.id} className={`agent-ticker-item is-${ev.tone}`}>
                <Icon name={TONE_ICON[ev.tone]} size={13} className="agent-ticker-icon" />
                <span className="agent-ticker-text">
                  <span className="agent-ticker-tone">{TONE_LABEL[ev.tone]}</span>
                  {ev.text}
                </span>
                <time className="agent-ticker-time">
                  {new Date(ev.ts).toLocaleTimeString("zh-CN", { hour12: false })}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
