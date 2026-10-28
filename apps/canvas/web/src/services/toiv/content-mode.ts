/**
 * 薄 re-export → `@/redline`（前端唯一红线决策面 · W1-A）。
 * 保留旧路径以免全仓 import 炸掉；新代码请直接从 `@/redline` 引入。
 * 禁止在本文件回填可见性/提交/纯 NSFW 判据逻辑。
 */
export {
    CLASSIC_NSFW_TO_MARKET,
    normalizeContentModes,
    normalizeContentModeFields,
    canShowContentModeToggle,
    resolveSubmitContentMode,
    appShowsR18Badge,
    appIsPureNsfw,
    appVisibleForContentMode,
    type ContentMode,
    type ContentModeApp,
} from "@/redline";
