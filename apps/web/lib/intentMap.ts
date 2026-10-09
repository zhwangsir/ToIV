/** 意图 → 公开最佳卡(计划 d 首页入口)。数据单源见 intentKeepers；本文件补 Icon 类型给 Web UI。 */
import type { IconName } from "@/components/ui/Icon";
import {
  INTENT_ENTRIES as KEEPER_ENTRIES,
  intentMarketPath,
  intentMarketQuery,
  isLocalIntentAppId,
  resolveIntentAppId,
  type IntentKeeper,
} from "@/lib/intentKeepers";

export type IntentEntry = Omit<IntentKeeper, "icon"> & { icon: IconName };

export const INTENT_ENTRIES: IntentEntry[] = KEEPER_ENTRIES.map((e) => ({
  ...e,
  icon: e.icon as IconName,
}));

export {
  intentMarketPath,
  intentMarketQuery,
  isLocalIntentAppId,
  resolveIntentAppId,
};
export type { IntentKeeper };
