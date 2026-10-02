/**
 * 速度分档(INTENT e 2026-10-03):快速 / 精细。
 * 用户可见两档(少字);H3 映射 acceleration;非 H3 由后端折半 steps。
 * localStorage 记忆,缺省精细(quality)。
 */

export type SpeedTier = "fast" | "quality";

export const SPEED_TIERS: readonly SpeedTier[] = ["fast", "quality"] as const;

export const DEFAULT_SPEED_TIER: SpeedTier = "quality";

export const SPEED_TIER_STORAGE_KEY = "toiv.speed_tier";

/** H3:fast→balanced / quality→off(与后端 resolve_h3_acceleration 对齐)。 */
export function speedTierToH3Accel(tier: SpeedTier): "off" | "balanced" {
  return tier === "fast" ? "balanced" : "off";
}

export function labelSpeedTier(tier: SpeedTier): string {
  return tier === "fast" ? "快速" : "精细";
}

export function parseSpeedTier(raw: unknown): SpeedTier {
  if (raw === "fast" || raw === "quality") return raw;
  return DEFAULT_SPEED_TIER;
}

export function loadSpeedTier(): SpeedTier {
  if (typeof window === "undefined") return DEFAULT_SPEED_TIER;
  try {
    return parseSpeedTier(window.localStorage.getItem(SPEED_TIER_STORAGE_KEY));
  } catch {
    return DEFAULT_SPEED_TIER;
  }
}

export function saveSpeedTier(tier: SpeedTier): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SPEED_TIER_STORAGE_KEY, tier);
  } catch {
    /* quota / private mode */
  }
}
