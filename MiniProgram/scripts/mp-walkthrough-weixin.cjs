#!/usr/bin/env node
/**
 * MP9 微信开发者工具自动化走查（Round 1：mock 后端全自动轮）
 * 检查点：W1 登录 / W2 创作页 / W3 提交+作业进度 SSE / W4 产物详情 / W5 作品库 /
 *        W6 资产库 / W7 对话助手 / W8 Agent 团队（含确认门裁决）/ W9 我的页
 * 前置：
 *   1. 微信开发者工具已打开 dist/build/mp-weixin，设置→安全设置开启自动化端口 9420
 *   2. mock-server 已启动（node scripts/mock-server.mjs → 9800）
 *   3. dist 以 VITE_API_BASE=http://127.0.0.1:9800 构建（project.config urlCheck=false）
 * 用法：node scripts/mp-walkthrough-weixin.cjs
 * 产出：docs/ux-walkthrough-weixin/*.png + 控制台结构化报告（非零退出 = 有失败检查点）
 *
 * 与 H5 走查（ux-walkthrough-h5.mjs）的平台差异：
 *   - 导航：mini.reLaunch/navigateTo 在 0.12.1 的 changeRoute 会把 {url} 对象二次包装
 *     （callWxMethod(t,{url:e})，e 需为字符串），且 wx.navigateTo 的 success/complete 回调
 *     在自动化通道下被吞（useApiHook 侧挂起）——统一改走 evaluate 直发 + waitRoute 轮询
 *   - 自定义组件需 $/$$ 穿透影子树（如 job-card → .job-card__progress）
 *   - showToast/showModal 为原生层，不入 WXML 树：toast 不断言，modal 用 mockWxMethod 自动确认
 *   - 文本断言统一 textOf（text() → 影子树文本节点 → wxml 剥离兜底）
 *   - mp 选择器引擎不匹配 data-* 裸存在性选择器（[data-run-status] → null）；
 *     必须带值（[data-run-status="done"]）或类选择器定位后 attribute() 读取（探针实证）
 */
const automator = require('miniprogram-automator');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const SHOTS = join(__dirname, '..', 'docs', 'ux-walkthrough-weixin');
mkdirSync(SHOTS, { recursive: true });

const WS = process.env.MP_WS || 'ws://localhost:9420';
const API = process.env.MP_API || 'http://127.0.0.1:9800';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = process.env.MP_DEBUG ? (s) => console.log(`[step ${new Date().toISOString().slice(17, 23)}] ${s}`) : () => {};

async function shot(mini, name) {
  try {
    await mini.screenshot({ path: join(SHOTS, `${name}.png`) });
  } catch (e) {
    console.log(`[shot] ${name} 截图失败（不影响判定）: ${e.message}`);
  }
}

/** 通用轮询：fn 返回真值即收，超时返回最后值（假值）。单次尝试限时 1.6s：路由切换窗内
 *  automator 元素查询会挂起直至其内部超时（≈10s），不设限会把整轮预算一次吞掉 */
async function poll(fn, timeout = 8000, interval = 200) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await Promise.race([fn(), sleep(1600).then(() => null)]);
    } catch {
      last = null;
    }
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

/** 当前页路由（去前导斜杠） */
async function route(mini) {
  const p = await mini.currentPage();
  return (p.path || '').replace(/^\//, '');
}

/** currentPage 安全版：页面切换窗内 automator 会抛 page is not on top of page stack，轮询收纳 */
async function curPage(mini, timeout = 8000) {
  const p = await poll(async () => {
    try {
      return await mini.currentPage();
    } catch {
      return null;
    }
  }, timeout);
  if (!p) throw new Error('currentPage 持续异常（页面栈抖动未收敛）');
  return p;
}

async function waitRoute(mini, pattern, timeout = 8000) {
  const re = new RegExp(pattern);
  const hit = await poll(async () => {
    const r = await route(mini);
    return re.test(r) ? r : null;
  }, timeout);
  return hit || '';
}

/** 页面就绪（硬失败带路由上下文）：selector 在 timeout 内出现则返回 page，否则抛出可诊断错误 */
async function mustPage(mini, selector, timeout = 10000, multi = false) {
  let lastRoute = '';
  let lastErr = '';
  let tries = 0;
  const page = await poll(async () => {
    tries += 1;
    try {
      const p = await mini.currentPage();
      if (!p) {
        lastErr = 'currentPage=null';
        return null;
      }
      lastRoute = p.path || '';
      let found;
      try {
        found = multi ? (await p.$$(selector)).length > 0 : !!(await p.$(selector));
        lastErr = found ? '' : `查询返回空(views=${(await p.$$('view')).length})`;
      } catch (e) {
        lastErr = `查询异常: ${e.message}`;
        return null;
      }
      return found ? p : null;
    } catch (e) {
      lastErr = `currentPage 异常: ${e.message}`;
      return null;
    }
  }, timeout);
  if (!page) {
    throw new Error(`页面元素未就绪: ${selector}（路由=${lastRoute || '?'} tries=${tries} 末态=${lastErr}）`);
  }
  return page;
}

/**
 * 导航（evaluate 直发 + 路由轮询 + 落定延时）：
 * 规避 automator changeRoute 的 {url} 二次包装缺陷与 wx.navigateTo 回调被吞的挂起；
 * settle 450ms 等渲染层挂载，避免紧随的元素查询打进页面切换窗而挂起
 */
async function nav(mini, method, url) {
  const stmt = url === undefined ? `wx.${method}()` : `wx.${method}({url:${JSON.stringify(url)}})`;
  await mini.evaluate(new Function(stmt)); // eslint-disable-line no-new-func
  await sleep(450);
}
const reLaunch = (mini, url) => nav(mini, 'reLaunch', url);

/** 元素文本：text() 优先 → 影子树常见文本节点 → wxml 剥离兜底（自定义组件兼容） */
async function textOf(el) {
  if (!el) return '';
  try {
    const t = await el.text();
    if (t && t.trim()) return t.trim();
  } catch {
    /* noop */
  }
  for (const inner of ['.ui-btn__label', '.ui-tag', '.ui-btn', 'text']) {
    try {
      const n = await el.$(inner);
      if (n) {
        const t2 = await n.text();
        if (t2 && t2.trim()) return t2.trim();
      }
    } catch {
      /* noop */
    }
  }
  try {
    const w = await el.wxml();
    return String(w).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** 在 scope（page 或元素）下找「内部选择器文本含 keyword」的元素（原生节点） */
async function findByInnerText(scope, sel, innerSel, keyword) {
  const els = await scope.$$(sel);
  for (const el of els) {
    const inner = innerSel ? await el.$(innerSel) : el;
    const t = await textOf(inner);
    if (t.includes(keyword)) return el;
  }
  return null;
}

/**
 * 自定义组件宿主查找：mp composed 树宿主标签为全路径（components/ui/button），别名与标签
 * 选择器均不可命中（page.$$('button')===0）；唯一稳定锚点是编译注入的 u-i 属性。
 * 收集 [u-i] 宿主后按「影子树内特征选择器」过滤；keyword 给定时再按特征节点文本过滤。
 */
async function findHost(scope, innerSel, keyword = '') {
  let list = [];
  try {
    list = await scope.$$('[u-i]');
  } catch {
    return null;
  }
  for (const h of list) {
    let inner = null;
    try {
      inner = await h.$(innerSel);
    } catch {
      /* noop */
    }
    if (!inner) continue;
    if (!keyword) return h;
    if ((await textOf(inner)).includes(keyword)) return h;
  }
  return null;
}

/** 收集「影子树内含特征选择器」的全部宿主 */
async function findHosts(scope, innerSel) {
  const out = [];
  let list = [];
  try {
    list = await scope.$$('[u-i]');
  } catch {
    return out;
  }
  for (const h of list) {
    try {
      if (await h.$(innerSel)) out.push(h);
    } catch {
      /* noop */
    }
  }
  return out;
}

/** 按提示词文本找 job-card 宿主（穿透影子树） */
async function findJobCard(page, promptKeyword) {
  for (const c of await findHosts(page, '.job-card__prompt')) {
    const t = await textOf(await c.$('.job-card__prompt'));
    if (t.includes(promptKeyword)) return c;
  }
  return null;
}

/**
 * 组件宿主点击：automator tap 宿主不触发 bindclick（宿主无实际渲染盒）；
 * 必须 tap 影子树内携带 bindtap 的原生节点（tapSel）
 */
async function tapInner(host, tapSel) {
  const inner = await host.$(tapSel);
  if (!inner) throw new Error(`tapInner: 宿主内未找到 ${tapSel}`);
  await inner.tap();
}

/**
 * 点卡进详情：tap 后等路由跳转；超时（tap 落空/导航迟滞，实证可达 20s+）重找卡重试一次。
 * 长时走查下 devtools 渲染进程拥塞，navigateTo 落定可能远超常规 8s 窗口
 */
async function tapCardToRoute(mini, findCard, pattern, timeout = 20000) {
  const card = await poll(findCard, 8000);
  if (card) await tapNav(() => card.tap());
  let r = await waitRoute(mini, pattern, timeout);
  if (r) return r;
  const retry = await poll(findCard, 6000);
  if (retry) await tapNav(() => retry.tap());
  r = await waitRoute(mini, pattern, timeout);
  return r;
}

/** 触发导航的 tap：devtools 响应竞态页面栈切换会回 page stack 错（导航已实际发生），收纳；其他错误照常抛 */
async function tapNav(tapFn) {
  try {
    await tapFn();
  } catch (e) {
    if (!/page is not on top of page stack/.test(String(e && e.message))) throw e;
  }
}

async function seed(body) {
  const res = await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function reset() {
  await fetch(`${API}/__reset`);
}

/** 作业卡状态原子读取（穿透 job-card 影子树；tag 为嵌套组件宿主，走 [u-i] + 特征探测） */
async function jobCardState(card) {
  if (!card) return null;
  const progress = await card.$('.job-card__progress');
  const pctEl = await card.$('.job-card__progress-text');
  const warn = await card.$('.job-card__warn');
  const img = await card.$('image.job-card__img');
  let badge = '';
  for (const h of await findHosts(card, '.ui-tag')) {
    badge = await textOf(await h.$('.ui-tag'));
    if (badge) break;
  }
  return {
    hasProgress: !!progress,
    pct: pctEl ? parseInt((await textOf(pctEl)).replace(/[^\d]/g, ''), 10) : 0,
    hasWarn: !!warn,
    badge,
    thumbSrc: img ? String(await img.attribute('src')) : '',
  };
}

(async () => {
  console.log(`[mp-walkthrough] 连接微信开发者工具 ${WS} …`);
  const mini = await automator.connect({ wsEndpoint: WS });
  await sleep(2000);
  console.log(`[mp-walkthrough] 已连接，当前路由：${await route(mini)}`);

  // 归零：清空本地存储（token/设置）+ mock 内存态
  await mini.evaluate(() => {
    try {
      wx.clearStorageSync();
    } catch (e) {
      /* noop */
    }
  });
  await reset();

  try {
    // ---------- W1 登录流（MP32 原生 button：微信 CTA + 账密直渲） ----------
    await reLaunch(mini, '/pages/login/login');
    let page = await mustPage(mini, '.field__input');
    // MP32 起登录按钮为原生 <button>（绕开 uni 自定义组件 prop 事件映射），
    // composed 树可直接命中 class；微信 CTA 条件编译仅本端渲染
    const pwdLoginBtn = await page.$('.login__submit');
    const wechatBtn = await page.$('.login__wechat');
    const emailInput = await page.$('.field__input');
    const pwdInput = await page.$('.field__input--password');
    check(
      'W1.1 登录页渲染（微信 CTA/邮箱/密码/登录钮直渲）',
      !!(emailInput && pwdInput && pwdLoginBtn && wechatBtn),
      `email=${!!emailInput} pwd=${!!pwdInput} btn=${!!pwdLoginBtn} wechat=${!!wechatBtn}`,
    );
    await emailInput.input('ux-walkthrough@toiv.dev');
    await pwdInput.input('mock-pass-123');
    await shot(mini, 'w1-login-filled');
    await pwdLoginBtn.tap();
    const w1Route = await waitRoute(mini, 'pages/index/index', 10000);
    check('W1.2 登录提交 → reLaunch 创作页', w1Route === 'pages/index/index', w1Route);

    // ---------- W2 创作页 ----------
    page = await mustPage(mini, 'textarea.create__prompt');
    // 引擎自动选择（首枚可用已接入引擎 = SDXL 文生图）
    const engineName = await poll(async () => {
      const el = await page.$('.create__engine-name');
      const t = await textOf(el);
      return t || null;
    });
    check('W2.1 引擎列表加载 + 默认引擎选中', engineName.includes('SDXL'), engineName);
    // 引擎抽屉（sheet 为页面级宿主；引擎项为 slot 内容 = 页面光 DOM）
    await (await page.$('.create__engine-btn')).tap();
    const engineSheet = await poll(() => findHost(page, '.ui-sheet__mask'), 6000);
    await poll(async () => (await page.$$('.engine-item')).length > 0, 6000);
    const engineItems = await page.$$('.engine-item');
    const r18Badges = await page.$$('.engine-item__badge');
    check(
      'W2.2 引擎抽屉渲染（SFW 上下文无 R18 徽标）',
      engineItems.length >= 8 && r18Badges.length === 0,
      `engines=${engineItems.length} r18=${r18Badges.length}`,
    );
    await shot(mini, 'w2-engine-sheet');
    // 关抽屉（遮罩在 sheet 宿主影子树内，一级穿透）
    const mask = engineSheet ? await engineSheet.$('.ui-sheet__mask') : null;
    if (mask) await mask.tap();
    await sleep(500);
    // 参数抽屉（param-sheet 宿主 → 其影子树内 .param 行）
    await (await page.$('.create__params-btn')).tap();
    const paramSheet = await poll(async () => {
      const ps = await findHost(page, '.param-sheet');
      if (!ps) return null;
      const rows = await ps.$$('.param');
      return rows.length > 0 ? { ps, rows } : null;
    }, 6000);
    check(
      'W2.3 参数抽屉渲染（txt2img 四维参数在册）',
      !!paramSheet && paramSheet.rows.length >= 4,
      `params=${paramSheet ? paramSheet.rows.length : 0}`,
    );
    await shot(mini, 'w2-param-sheet');
    // 关参数抽屉：遮罩在 param-sheet 内层 ui-sheet 的影子树里（二级宿主穿透）
    const psInnerSheet = paramSheet ? await findHost(paramSheet.ps, '.ui-sheet__mask') : null;
    const pMask = psInnerSheet ? await psInnerSheet.$('.ui-sheet__mask') : null;
    if (pMask) await pMask.tap();
    await sleep(500);

    // ---------- W3 提交 + 作业进度 SSE（对齐 H5 C32.1/C32.3） ----------
    // success 剧本：种子 running 作业（prompt_id 对齐 txt2img 固定回包 p-new-1）
    await reset();
    await seed({
      jobs: [
        { id: 'w3-ok', prompt_id: 'p-new-1', status: 'running', prompt: '走查 SSE 成功', results: [] },
      ],
      sseJobs: [{ prompt_id: 'p-new-1', scenario: 'success' }],
    });
    /** 创作页提交 txt2img → 凭据登记 → reLaunch 作业页 */
    async function submitTxt2Img(promptText) {
      await reLaunch(mini, '/pages/index/index');
      const p = await mustPage(mini, 'textarea.create__prompt');
      await (await p.$('textarea.create__prompt')).input(promptText);
      // .create__submit 类编在组件宿主上；tap 需落到影子树内 .ui-btn（bindtap 载体）
      const submitHost = await poll(async () => (await p.$('.create__submit')) || null, 6000);
      if (!submitHost) throw new Error('创作页提交钮宿主未出现（.create__submit）');
      await tapInner(submitHost, '.ui-btn');
      return waitRoute(mini, 'pages/jobs/jobs', 10000);
    }
    const w3Route = await submitTxt2Img('走查 SSE：雪夜灯箱，胶片颗粒');
    check('W3.1 txt2img 提交成功 → reLaunch 作业页', w3Route === 'pages/jobs/jobs', w3Route);

    page = await curPage(mini);
    const okCard = await poll(() => findJobCard(page, '走查 SSE 成功'), 8000);
    // 进度条出现
    let st = await poll(async () => {
      const s = await jobCardState(okCard);
      return s && s.hasProgress ? s : null;
    }, 8000);
    const w32Bar = !!st;
    const pctA = st ? st.pct : 0;
    // pct 单调增长（SSE 帧 300ms 间隔推进）
    const stB = await poll(async () => {
      const s = await jobCardState(okCard);
      return s && s.hasProgress && s.pct > pctA ? s : null;
    }, 6000);
    check(
      'W3.2 会话内作业 SSE：进度条出现 + pct 单调增长',
      w32Bar && !!stB,
      `bar=${w32Bar} pct=${pctA}→${stB ? stB.pct : '-'}`,
    );
    // done 收口：进度条消失 + 徽章「已完成」+ 产物图
    const stDone = await poll(async () => {
      const s = await jobCardState(okCard);
      return s && !s.hasProgress && s.badge.includes('已完成') && s.thumbSrc.includes('/outputs/')
        ? s
        : null;
    }, 12000);
    check(
      'W3.3 SSE done 收口（进度条消失/徽章已完成/产物图）',
      !!stDone,
      stDone ? `badge=${stDone.badge} thumb=${stDone.thumbSrc.slice(-24)}` : '超时未收口',
    );
    await shot(mini, 'w3-sse-done');

    // error 剧本 + 轮询兜底：error 帧 → 徽章「失败」；无凭据作业全程无进度条
    await reset();
    await seed({
      jobs: [
        { id: 'w3-err', prompt_id: 'p-new-1', status: 'running', prompt: '走查 SSE 失败', results: [] },
        { id: 'w3-poll', prompt_id: 'p-nocreds', status: 'running', prompt: '走查无凭据轮询兜底', results: [] },
      ],
      sseJobs: [{ prompt_id: 'p-new-1', scenario: 'error' }],
    });
    await submitTxt2Img('走查 SSE：雨夜霓虹，赛博街巷');
    page = await curPage(mini);
    const errCard = await poll(() => findJobCard(page, '走查 SSE 失败'), 8000);
    // 进度条采样必须先于无凭据卡查找：findJobCard 全宿主扫描为数十轮 IPC（2-4s），
    // 先找卡再采样会吞掉 error 剧本 ≈1.8s 的进度帧窗（mock 已加密到 6 帧）
    const w34SseBar = !!(await poll(async () => {
      const s = await jobCardState(errCard);
      return s && s.hasProgress ? s : null;
    }, 8000));
    const noCredsCard = await poll(() => findJobCard(page, '走查无凭据轮询兜底'), 8000);
    const noCredsEarly = await jobCardState(noCredsCard);
    const stErr = await poll(async () => {
      const s = await jobCardState(errCard);
      return s && !s.hasProgress && s.badge.includes('失败') ? s : null;
    }, 12000);
    const noCredsLate = await jobCardState(noCredsCard);
    const w34NoCredsClean =
      noCredsEarly && noCredsEarly.hasProgress === false && noCredsLate && noCredsLate.hasProgress === false;
    check(
      'W3.4 error 帧 → 徽章「失败」收口 + 无凭据作业全程无进度条（轮询兜底）',
      w34SseBar && !!stErr && !!w34NoCredsClean,
      `sseBar=${w34SseBar} failed=${!!stErr} noCreds early=${noCredsEarly && noCredsEarly.hasProgress} late=${noCredsLate && noCredsLate.hasProgress}`,
    );
    await shot(mini, 'w3-sse-error');

    // ---------- W4 产物详情（eventChannel + 版本链横滑条带） ----------
    await reset();
    await reLaunch(mini, '/pages/jobs/jobs');
    page = await poll(async () => {
      const p = await mini.currentPage();
      if (!p || !(p.path || '').includes('pages/jobs/jobs')) return null;
      return (await findHosts(p, '.job-card__prompt')).length > 0 ? p : null;
    });
    if (!page) throw new Error('作业页 job-card 未就绪');
    const doneCard = await poll(() => findJobCard(page, '胶片暗房里的猫'), 8000);
    if (!doneCard) throw new Error('未找到已完成作业卡（胶片暗房里的猫）');
    await tapNav(() => tapInner(doneCard, '.job-card'));
    const w4Route = await waitRoute(mini, 'pages-sub/artifact/artifact', 8000);
    check('W4.1 点已完成卡 → 跳转详情页', w4Route.includes('pages-sub/artifact/artifact'), w4Route);
    page = await curPage(mini);
    // eventChannel 数据到达 → 不停留在「加载中」
    const w4Loaded = await poll(async () => {
      const media = await page.$('.artifact__media');
      return media || null;
    }, 8000);
    const stuckHint = await page.$('.artifact__hint');
    check('W4.2 详情页 eventChannel 数据到达 + 预览区渲染', !!w4Loaded && !stuckHint, stuckHint ? '停在加载/空态' : 'ok');
    // 版本链：mock /versions 返回 2 版 → 横滑条带 v1/v2
    const versions = await poll(async () => {
      const vs = await page.$$('.artifact__version');
      return vs.length >= 2 ? vs : null;
    }, 8000);
    let vLabels = '';
    if (versions) {
      for (const v of versions) {
        const lb = await v.$('.artifact__version-label');
        vLabels += (await textOf(lb)) + ' ';
      }
    }
    check(
      'W4.3 版本链横滑条带渲染（v1/v2）',
      !!versions && vLabels.includes('v1') && vLabels.includes('v2'),
      `versions=${versions ? versions.length : 0} labels="${vLabels.trim()}"`,
    );
    await shot(mini, 'w4-artifact-versions');
    const reuseBtn = await page.$('.artifact__reuse');
    const iconBtns = await page.$$('.artifact__icon-btn');
    check(
      'W4.4 操作钮渲染（复用提示词 + 重新生成/下载/删除）',
      !!reuseBtn && iconBtns.length >= 3,
      `reuse=${!!reuseBtn} icons=${iconBtns.length}`,
    );

    // ---------- W5 作品库 ----------
    await reset();
    await seed({ jobs: [{ kind: 'wan_t2v', prompt: '走查视频作品' }] });
    await reLaunch(mini, '/pages/library/library');
    page = await mustPage(mini, '.library__chip', 10000, true);
    await poll(async () => (await page.$$('.library__card')).length > 0, 8000);
    const chips = await page.$$('.library__chip');
    const libCards = await page.$$('.library__card');
    check('W5.1 过滤芯片 + 作品卡渲染', chips.length >= 4 && libCards.length >= 1, `chips=${chips.length} cards=${libCards.length}`);
    // 音频过滤：服务端整库生效（默认数据集 5 件音频，对齐 H5 C19.4；种子为视频不干扰计数）
    const audioChip = await findByInnerText(page, '.library__chip', '.library__chip-label', '音频');
    await audioChip.tap();
    const audioOnly = await poll(async () => {
      const cards = await page.$$('.library__card');
      return cards.length === 5 ? cards : null;
    }, 8000);
    check('W5.2 「音频」过滤 → 服务端整库 5 卡（对齐 H5 C19.4）', !!audioOnly, `cards=${audioOnly ? audioOnly.length : '?'}`);
    await shot(mini, 'w5-library-audio');
    // 音频桶内（5 卡全量已加载）→ 选择模式 → 全选 → 计数「已选 5 项」→ 退出
    await (await page.$('[data-action="enter-select"]')).tap();
    const batchBar = await poll(async () => (await page.$('.library__batch-bar')) || null, 6000);
    await (await page.$('[data-action="select-all"]')).tap();
    const batchCountText = await poll(async () => {
      const el = await page.$('.library__batch-count');
      const t = await textOf(el);
      return t.includes('已选 5 项') ? t : null;
    }, 6000);
    check(
      'W5.3 选择模式：进入 → 全选 → 计数「已选 5 项」',
      !!batchBar && !!batchCountText,
      `bar=${!!batchBar} count="${batchCountText || ''}"`,
    );
    await shot(mini, 'w5-library-batch');
    await (await page.$('[data-action="exit-select"]')).tap();
    await sleep(400);

    // ---------- W6 资产库（我的页入口） ----------
    await reset();
    await seed({ assets: [{ name: '走查角色卡', kind: 'character' }] });
    await reLaunch(mini, '/pages/profile/profile');
    page = await mustPage(mini, '.profile__email');
    const assetsRow = await findByInnerText(page, '.profile__row', '.profile__row-label', '参考资产库');
    await tapNav(() => assetsRow.tap());
    const w6Route = await waitRoute(mini, 'pages/assets/index', 8000);
    check('W6.1 我的页入口 → 资产库页', w6Route === 'pages/assets/index', w6Route);
    page = await curPage(mini);
    const assetCard = await poll(() => findByInnerText(page, '.assets__card', '.assets__name', '走查角色卡'), 8000);
    check('W6.2 种子资产卡渲染（名称在册）', !!assetCard);
    // 新建入口 → 弹层表单渲染（button 为无特征类组件宿主，走 [u-i] + 标签文本；tap 落内层）
    const createBtn = await poll(() => findHost(page, '.ui-btn__label', '新建资产'), 6000);
    if (createBtn) await tapInner(createBtn, '.ui-btn');
    const assetForm = await poll(async () => (await page.$('.asset-form__name-input')) || null, 6000);
    check('W6.3 新建资产弹层渲染（名称输入框）', !!assetForm);
    await shot(mini, 'w6-assets-form');
    const aSheet = await findHost(page, '.ui-sheet__mask');
    const aMask = aSheet ? await aSheet.$('.ui-sheet__mask') : null;
    if (aMask) await aMask.tap();
    await sleep(400);

    // ---------- W7 对话助手（SSE 流式） ----------
    await reLaunch(mini, '/pages/index/index');
    page = await mustPage(mini, '.create__assistant-btn');
    await tapNav(async () => (await page.$('.create__assistant-btn')).tap());
    const w7Route = await waitRoute(mini, 'pages/assistant/assistant', 8000);
    page = await curPage(mini);
    // pinia 内存态随 app 实例存活（reLaunch 不重置）：前轮走查已发消息时先点「新对话」清空再断言空态
    const navBtns = await page.$$('.assistant__nav-btn');
    if (navBtns.length > 0) await navBtns[0].tap();
    const emptyState = await poll(async () => {
      const el = await page.$('.assistant__empty');
      return el || null;
    }, 6000);
    check('W7.1 创作页助手入口 → 助手页空态渲染', w7Route.includes('pages/assistant/assistant') && !!emptyState, w7Route);
    // 发送首轮 → 用户气泡 + 流式回复 + 生成图内联
    const ta = await page.$('textarea.assistant__textarea');
    await ta.input('画一只胶片风的猫');
    await (await page.$('.assistant__send')).tap();
    const replyEl = await poll(
      async () => findByInnerText(page, '.assistant__text', null, '已按你的想法生成了一张图'),
      10000,
    );
    const mediaImg = await poll(async () => (await page.$('.assistant__media-image')) || null, 8000);
    check('W7.2 发送 → 流式回复 + 生成图内联渲染', !!replyEl && !!mediaImg, `reply=${!!replyEl} image=${!!mediaImg}`);
    await shot(mini, 'w7-assistant-replied');
    // 流式中停止 → 发送键恢复（mock 5 帧×150ms，窗口内点击）
    await ta.input('再画一张暖色调');
    await (await page.$('.assistant__send')).tap();
    let stopOk = false;
    const stopBtn = await poll(async () => (await page.$('.assistant__send--stop')) || null, 3000, 100);
    if (stopBtn) {
      await stopBtn.tap();
      stopOk = !!(await poll(async () => ((await page.$('.assistant__send--stop')) ? null : true), 6000, 150));
    }
    check('W7.3 流式中停止 → 中断后发送键恢复', stopOk, `stopBtn=${!!stopBtn}`);
    await shot(mini, 'w7-assistant-stopped');

    // ---------- W8 Agent 团队（监控 + 确认门裁决） ----------
    await reset();
    const seedRes = await seed({
      agentRuns: [
        { goal: '雨夜侦探短片', status: 'running', scenario: 'success' },
        {
          goal: '咖啡店开业宣传片',
          status: 'awaiting_confirm',
          scenario: 'gate',
          history: [
            { event: 'ack', data: { message: '已拆成 3 步', level: 'L2' } },
            { event: 'confirm_required', data: { gate: 'plan', message: '请确认计划' } },
          ],
        },
        { goal: '产品功能介绍动画', status: 'planning', scenario: 'pending' },
      ],
    });
    const [successRun, gateRun] = seedRes.runs;
    await reLaunch(mini, '/pages/jobs/jobs');
    page = await mustPage(mini, '[data-action="open-agent-runs"]');
    await tapNav(async () => (await page.$('[data-action="open-agent-runs"]')).tap());
    const w8Route = await waitRoute(mini, 'pages/agent-runs/agent-runs', 8000);
    page = await curPage(mini);
    await poll(async () => (await page.$$('.runs__card')).length >= 3, 8000);
    const runCards = await page.$$('.runs__card');
    let runsText = '';
    for (const c of runCards) runsText += `${await textOf(c)} `;
    check(
      'W8.1 作业页 Agent 入口 → 运行列表 3 卡（执行中/待确认计划/规划中）',
      w8Route.includes('pages/agent-runs/agent-runs') &&
        runCards.length === 3 &&
        runsText.includes('执行中') &&
        runsText.includes('待确认计划') &&
        runsText.includes('规划中'),
      `cards=${runCards.length}`,
    );
    await shot(mini, 'w8-agent-runs-list');
    // 过滤「待确认」桶
    const gateChip = await poll(async () => {
      const chips = await page.$$('.runs__chip');
      for (const ch of chips) {
        const f = await ch.attribute('data-filter');
        if (f === 'gate') return ch;
      }
      return null;
    }, 6000);
    await gateChip.tap();
    const gateOnly = await poll(async () => {
      const cards = await page.$$('.runs__card');
      if (cards.length !== 1) return null;
      const t = await textOf(cards[0]);
      return t.includes('咖啡店开业宣传片') ? cards : null;
    }, 6000);
    check('W8.2 过滤「待确认」桶 → 仅确认门 run', !!gateOnly);
    const allFilterChip = await poll(async () => {
      const chips = await page.$$('.runs__chip');
      for (const ch of chips) {
        const f = await ch.attribute('data-filter');
        if (f === 'all') return ch;
      }
      return null;
    }, 6000);
    MARK('w8: allFilterChip.tap before');
    await allFilterChip.tap();
    MARK('w8: allFilterChip.tap after');
    await sleep(500);
    // 成功剧本详情：SSE 接力 → 徽章跃迁 done + 动态流 + 图/视频产物
    const findSuccessCard = async () => {
      const cards = await page.$$('.runs__card');
      for (const c of cards) {
        const id = await c.attribute('data-run-id');
        if (id === successRun.id) return c;
      }
      return null;
    };
    const w83Route = await tapCardToRoute(mini, findSuccessCard, 'pages/agent-runs/detail');
    MARK(`w8: detail route=${w83Route || 'timeout'}`);
    page = await curPage(mini);
    // mp 不匹配 [data-run-status] 裸选择器 → 带值轮询（探针实证 [data-run-status="done"] 可命中）
    MARK('w8: done poll start');
    const w83Done = await poll(async () => ((await page.$('[data-run-status="done"]')) ? 'done' : null), 15000);
    MARK(`w8: done poll end=${w83Done}`);
    // 迟到导航可能在轮询期间换顶 → 刷新 page 句柄再读产物（旧句柄查询会抛 page stack 错）
    page = await curPage(mini);
    const feedEl = await poll(async () => (await page.$('.detail__feed')) || null, 6000);
    const feedCount = feedEl ? parseInt(String(await feedEl.attribute('data-feed-count')), 10) : 0;
    const taskVideos = await poll(async () => ((await page.$$('.detail__task-video')) || []).length > 0 ? await page.$$('.detail__task-video') : null, 6000) || [];
    const taskImages = await poll(async () => ((await page.$$('.detail__task-image')) || []).length > 0 ? await page.$$('.detail__task-image') : null, 6000) || [];
    check(
      'W8.3 详情 SSE 接力 → 徽章跃迁 done + 动态流上屏 + 图/视频产物',
      w83Done === 'done' && feedCount >= 7 && taskVideos.length === 1 && taskImages.length === 1,
      `done=${w83Done} feed=${feedCount} video=${taskVideos.length} image=${taskImages.length}`,
    );
    await shot(mini, 'w8-agent-run-done');
    // 确认门 run：去裁决 → 计划抽屉 3 任务 → 确认通过 → 徽章「执行中」
    MARK('w8: navigateBack');
    await nav(mini, 'navigateBack');
    await waitRoute(mini, 'pages/agent-runs/agent-runs', 15000);
    page = await curPage(mini);
    await poll(async () => (await page.$$('.runs__card')).length >= 3, 8000);
    const findGateCard = async () => {
      const cards = await page.$$('.runs__card');
      for (const c of cards) {
        const id = await c.attribute('data-run-id');
        if (id === gateRun.id) return c;
      }
      return null;
    };
    const w84Route = await tapCardToRoute(mini, findGateCard, 'pages/agent-runs/detail');
    MARK(`w8: gate detail route=${w84Route || 'timeout'}`);
    page = await curPage(mini);
    const gateCta = await poll(async () => (await page.$('[data-action="open-gate"]')) || null, 8000);
    MARK('w8: gateCta.tap');
    if (gateCta) await gateCta.tap();
    const gateItems = await poll(async () => {
      const items = await page.$$('.gate__item');
      return items.length >= 3 ? items : null;
    }, 6000);
    check('W8.4a 确认门「去裁决」→ 计划抽屉渲染（3 任务）', !!gateItems, `items=${gateItems ? gateItems.length : 0}`);
    await shot(mini, 'w8-gate-sheet');
    const confirmBtn = await poll(async () => (await page.$('[data-action="plan-confirm"]')) || null, 6000);
    MARK('w8: confirmBtn.tap');
    if (confirmBtn) await confirmBtn.tap();
    let w84Running = await poll(
      async () => ((await page.$('[data-run-status="running"]')) ? 'running' : null),
      10000,
    );
    if (!w84Running) {
      // tap 落空兜底（抽屉动画/截图后层级抖动）：重找钮重试一次；仍败则采集抽屉内联错误定位
      MARK('w8: confirm retry');
      const retryBtn = await poll(async () => (await page.$('[data-action="plan-confirm"]')) || null, 4000);
      if (retryBtn) await retryBtn.tap();
      w84Running = await poll(
        async () => ((await page.$('[data-run-status="running"]')) ? 'running' : null),
        10000,
      );
    }
    let gateErrText = '';
    if (!w84Running) {
      const errEl = await poll(async () => (await page.$('[data-plan-error]')) || null, 3000);
      gateErrText = errEl ? await textOf(errEl) : '';
    }
    check(
      'W8.4b 计划确认通过 → 徽章跃迁「执行中」',
      w84Running === 'running',
      `status=${w84Running || '?'}${gateErrText ? ` gateErr=${gateErrText}` : ''}`,
    );
    await shot(mini, 'w8-gate-approved');

    // ---------- W9 我的页 ----------
    await reLaunch(mini, '/pages/profile/profile');
    page = await mustPage(mini, '.profile__email');
    const email = await textOf(await page.$('.profile__email'));
    check('W9.1 用户信息渲染（mock 邮箱）', email.includes('ux-walkthrough@toiv.dev'), email);
    const sections = await page.$$('.profile__section');
    let sectionText = '';
    for (const s of sections) sectionText += `${await textOf(s)} `;
    const apiRow = await findByInnerText(page, '.profile__row', '.profile__row-label', 'API 基址');
    check(
      'W9.2 区块渲染（外观/资产/高级/关于 + API 基址行）',
      sectionText.includes('外观') &&
        sectionText.includes('资产') &&
        sectionText.includes('高级') &&
        sectionText.includes('关于') &&
        !!apiRow,
      sectionText.trim(),
    );
    await shot(mini, 'w9-profile');
    // 退出登录：原生 showModal 用 mock 自动确认
    await mini.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' });
    await tapNav(async () => (await page.$('.profile__signout')).tap());
    const w9Route = await waitRoute(mini, 'pages/login/login', 8000);
    await mini.restoreWxMethod('showModal');
    check('W9.3 退出登录 → 回登录页', w9Route === 'pages/login/login', w9Route);
    await shot(mini, 'w9-signout-login');
  } catch (e) {
    console.error('[mp-walkthrough] 异常中断:', e);
    check('走查异常中断', false, e.message);
  } finally {
    await mini.disconnect();
  }

  // ---------- 报告 ----------
  const passed = results.filter((r) => r.ok).length;
  console.log('\n========== MP9 微信走查报告（Round 1） ==========');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  console.log(`\n通过 ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})();
