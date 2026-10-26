/**
 * R18 上下文开关(D-U1 拍板 2026-10-15:纯本地自用,canvas 内建 R18 门控模式)。
 *
 * 语义:开启后 toivHttp 全部请求附加 `X-NSFW: 1`,后端中间件置位
 * nsfw_intent → R18 模型/应用/作品在该上下文可见。
 * **未成年硬阻断见后端 `app.redline`(本文件不复制年龄判定,只做本地开关+header+UI)。**
 * 状态持久化 localStorage;dataset.r18 供全局样式钩子。
 * 开关本身不做内容判断——门控是「确认动作」而非「内容审查」。
 */
const R18_KEY = "toiv_r18_mode";

export function isR18Mode(): boolean {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(R18_KEY) === "1";
}

function applyDataset(on: boolean): void {
    if (typeof document === "undefined") return;
    if (on) document.documentElement.dataset.r18 = "1";
    else delete document.documentElement.dataset.r18;
}

/** 启动时恢复持久化状态(html attr 供壳层徽标/样式使用);在应用入口调用一次。 */
export function initR18Mode(): void {
    applyDataset(isR18Mode());
}

export function setR18Mode(on: boolean): void {
    if (typeof window === "undefined") return;
    if (on) window.localStorage.setItem(R18_KEY, "1");
    else window.localStorage.removeItem(R18_KEY);
    applyDataset(on);
}

/** client.ts 拦截器用:R18 模式是否生效(请求应附加 X-NSFW: 1)。 */
export function nsfwHeaderEnabled(): boolean {
    return isR18Mode();
}
