"use client";

import { useCallback, useEffect, useState } from "react";

import {
  getDramaPlaybackInsights,
  type PlaybackInsightsResponse,
} from "@/lib/api";

export interface UsePlaybackInsightsReturn {
  data: PlaybackInsightsResponse | null;
  loading: boolean;
  error: string;
  refresh: () => void;
}

export function usePlaybackInsights(
  projectId: string | null,
): UsePlaybackInsightsReturn {
  const [data, setData] = useState<PlaybackInsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!projectId) {
      setData(null);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await getDramaPlaybackInsights(projectId);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载播放数据失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: load };
}
