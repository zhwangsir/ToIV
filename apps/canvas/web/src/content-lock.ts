import type { ContentPolicy, PolicyLocation } from "./content-policy";

const gatedPaths = ["/nsfw"];
const gatedQuery: ContentPolicy["gatedQuery"] = {
    category: ["r18", "nsfw"],
    content_mode: ["nsfw"],
    nsfw: ["1", "true", "yes"],
    mode: ["nsfw", "r18"],
    filter: ["r18", "nsfw"],
};
const adultOnlyPoseSystems = ["全身单人・性感系", "双人缠绵"];
const contentGateCategories = ["moderation_input", "moderation_reference", "moderation_output", "r18_context_required", "route_guard_adult", "sensitive_words_detected"];

function isUnderage(birthdate: string | null): boolean {
    const raw = (birthdate ?? "").trim();
    if (!raw) return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (!match) return false;
    const birth = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isNaN(birth.getTime())) return false;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const beforeBirthday =
        today.getMonth() < birth.getMonth() ||
        (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
    if (beforeBirthday) age -= 1;
    return age < 18;
}

function isGatedLocation(location: PolicyLocation, exclusiveAppIds: readonly string[]): boolean {
    const raw = location.pathname || "/";
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    const pathname = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    if (pathname === "/settings") return false;
    if (gatedPaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return true;
    const params = new URLSearchParams(location.search || "");
    for (const [key, values] of Object.entries(gatedQuery)) {
        const value = (params.get(key) || "").trim().toLowerCase();
        if (value && values.includes(value)) return true;
    }
    return exclusiveAppIds.includes((params.get("app") || "").trim());
}

export const contentPolicy: ContentPolicy = {
    id: "D-U1=B-frontend-guard",
    fallbackImageBasename: "Qwen-Rapid-AIO-SFW-v23.safetensors",
    fallbackVideoModel: "local-wan",
    gatedPaths,
    gatedQuery,
    adultOnlyPoseSystems,
    copy: {
        underageAdult: "当前账号未满足成人内容使用条件",
        guardReason: "当前为普通模式，此页需切换到成人模式",
        switchToAdult: "切换到成人模式",
        stayNormal: "留在普通内容",
        confirmSwitch: "确认切换？将对你账号下所有设备生效。",
        slotAdult: "需成人",
        lockLabel: "NSFW",
        lockedHint: "当前为普通模式，成人模型已锁定",
        modelsHiddenEmpty: "当前为普通模式，成人模型已锁定（灰化不可选）",
        appsHiddenEmpty: "当前为普通模式，纯成人应用已隐藏",
        mediaLocked: "成人内容已锁定",
        poseSystemsHidden: "成人体系已隐藏",
        fallbackTip: "已回落普通默认模型（出图 Qwen-Rapid-AIO-SFW-v23 / 出视频 local-wan）",
        adultRequiredReason: "当前为普通模式；该内容需切换到成人模式后可见或可生成",
        adultRequiredAction: "请切换到成人模式；确认后本机进入成人内容上下文",
        guardAction: "请切换到成人模式；确认后由守卫放行",
        retryNeedsChangedInput: "请先修改提示词或参考",
        modeUpdatedNewAttempt: "模式已更新 · 改输入后新建尝试",
        lockedLabel: "已锁定",
        assetLockedHint: "当前为普通模式，成人资产已锁定",
        taskLockedHint: "当前为普通：NSFW 任务已锁定",
        queueLockedHint: "成人任务已锁定",
    },
    isUnderage,
    allowsContent: (adultOn) => adultOn,
    isAppVisible: (pure, adultOn) => adultOn || !pure,
    isAssetListable: (rating, adultOn) => rating !== "unknown" || adultOn,
    isAssetSelectable: (rating, adultOn) => rating === "sfw" || adultOn,
    isPoseVisible: (system, adultOn) => !adultOnlyPoseSystems.includes(system) || adultOn,
    isGatedLocation,
    shouldSoften: (adultOn) => !adultOn,
    shouldFallback: (previousAdult, nextAdult) => previousAdult && !nextAdult,
    shouldConfirmModeSwitch: (previousAdult, nextAdult) => !previousAdult && nextAdult,
    isContentGate: (category) => contentGateCategories.includes(category),
    allowsAutomaticRetry: (category) => !contentGateCategories.includes(category),
    coverage: [
        "path /nsfw 及子路径",
        "query category=r18|nsfw（市场 R18 分类）",
        "query content_mode=nsfw|mode=nsfw|nsfw=1|filter=r18",
        "query app= 纯 R18 市场应用（CLASSIC via=is_nsfw_app）",
        "/settings 含 focus=r18 永不拦截（开启入口）",
        "选型列表：已知 NSFW 普通态可见不可选；未知元数据普通藏/成人显",
        "切模式不中断在途；软化仅普通路径",
        "未成年硬关 FE-only：isUnderage←/auth/me birthdate 同步",
        "姿势库体系闸：全身单人・性感系 / 双人缠绵 仅 adult",
        "失败重试闸：审核/R18 类失败需改提示词或参考后才可新建尝试",
        "成人闸文案：需成人槽标签、切换引导与失败提示均由本文件提供",
    ],
};
