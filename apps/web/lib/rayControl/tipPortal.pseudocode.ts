/**
 * PSEUDOCODE ONLY — JR-R5 tip portal FE landing (Cycle 66/改码卡 narrow merge).
 *
 * tip_mount MUST stay false. Do not import this into live ArcReel / task-center
 * mounts. Contract source of truth:
 *   apps/api/app/ray_control/stream_tip_portal.py
 *   apps/api/app/ray_control/stream_readonly_shell_tip_mount.py
 *
 * This file documents the intended client shape for a future 改码卡 that flips
 * tip_mount after Ray LAN + hub consumer wiring. No live EventSource / hub.
 */

export const TIP_MOUNT = false as const;
export const PRODUCT_PATH = "fe_tip_portal_pseudocode" as const;

/** Mirrors stream_tip_portal open intent (offline). */
export type TipOpenIntent = {
  surface: "create_rail" | "task_center" | string;
  tip_mount: false;
  accepted: false;
  delay_ms: number;
  reason: "tip_mount_false_until_kouling";
};

export type TipPortalBindings = {
  tip_mount: false;
  product_path: typeof PRODUCT_PATH;
  hosts: Array<"create_rail" | "task_center">;
  mutate_actions_blocked: true;
};

export function planTipPortalOpen(surface: TipOpenIntent["surface"] = "create_rail"): TipOpenIntent {
  return {
    surface,
    tip_mount: false,
    accepted: false,
    delay_ms: 0,
    reason: "tip_mount_false_until_kouling",
  };
}

export function tipPortalBindings(): TipPortalBindings {
  return {
    tip_mount: false,
    product_path: PRODUCT_PATH,
    hosts: ["create_rail", "task_center"],
    mutate_actions_blocked: true,
  };
}
