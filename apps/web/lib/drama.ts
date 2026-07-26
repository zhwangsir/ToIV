export interface DramaChapter {
  id: string;
  title: string;
  start: number;
  color: string;
}

export type DramaEventType =
  | "play"
  | "pause"
  | "seek"
  | "completed"
  | "timeupdate"
  | "chapter_enter"
  | "chapter_exit"
  | "like"
  | "replay"
  | "rate_change"
  | "fullscreen_change"
  | "mark_good"
  | "mark_boring"
  | "share_click"
  | "drop_off"
  | "first_play_delay"
  | "buffering";

export interface DramaEvent {
  event_id: string;
  session_id: string;
  user_id: string;
  drama_id: string;
  event_type: DramaEventType;
  current_time?: number;
  duration?: number;
  payload?: Record<string, unknown>;
  client_ts: number;
}

export interface DramaMetrics {
  completion_rate: number;
  avg_watch_sec: number;
  replay_rate: number;
  engagement_rate: number;
  chapter_drop: Record<string, number>;
  heatmap: { second: number; retention: number }[];
}
