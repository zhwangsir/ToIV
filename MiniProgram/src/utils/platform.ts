/**
 * 平台判断（编译期常量 process.env.UNI_PLATFORM，摇树友好）
 * 优先用它做运行时分支；必须平台隔离的模板片段再用条件编译
 */

export function isH5(): boolean {
  return process.env.UNI_PLATFORM === 'h5';
}

export function isMpWeixin(): boolean {
  return process.env.UNI_PLATFORM === 'mp-weixin';
}

export function isApp(): boolean {
  return process.env.UNI_PLATFORM === 'app-plus' || process.env.UNI_PLATFORM === 'app';
}

/** 当前编译平台标识原文（h5 / mp-weixin / mp-alipay / ...），诊断信息等场景用 */
export function platformName(): string {
  return process.env.UNI_PLATFORM ?? 'unknown';
}
