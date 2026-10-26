/**
 * 薄 re-export → `@/redline`（前端唯一红线决策面）。
 * 保留旧路径以免全仓 import 炸掉；新代码请直接从 `@/redline` 引入。
 */
export {
    initR18Mode,
    isR18Mode,
    isUnderage,
    nsfwAllowed,
    nsfwHeaderEnabled,
    setR18Mode,
    setStoredBirthdate,
    R18_SETTINGS_GATE_PATH,
    REQUEST_HEADER,
    REQUEST_HEADER_VALUE,
} from "@/redline";
