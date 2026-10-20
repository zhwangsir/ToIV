"""R18 统一口径(D-U1=B,2026-10-15 用户拍板)。

真源:`docs/ops/UI_UNIFY_FUSION_PLAN_20261014.md` §4 D-U1 + `TECH_STACK_EXEC_LOG` 批3。

策略(产品已拍板,代码必须对齐):
  1. **canvas = 唯一主 UI**,内建 R18 门控模式(设置开关+确认门+请求附 `X-NSFW: 1`)。
  2. **web** 退役到登录+官网落地,**不再保留独立 /nsfw 专区面**作为长期架构。
  3. **后端**只认请求级 `X-NSFW` ContextVar(见 `nsfw_ctx`);账户 `nsfw_enabled` 废弃不放行。
  4. **未成年硬阻断**优先于任何头/开关(法律底线,非架构红线)。
  5. **fail-closed**:无 `X-NSFW` → 成人模型/智能体/作品一律不可见/不可操作。

非本文件决策(执行债,见 docs/ops/R18_POLICY_D_U1B_20261020.md):
  · web 经典壳是否仍暂留 NSFW 引擎台(F12 残债 vs 立刻 302 canvas)。
  · canvas 是否对「非目录类」请求也附 X-NSFW(当前=会话级全请求,与 D-U1 一致)。
"""
from __future__ import annotations

# 稳定字符串供测试与运维文档交叉引用
POLICY_ID = "D-U1=B"
POLICY_DECIDED_AT = "2026-10-15"
CANVAS_IS_SOLE_MAIN_UI = True
WEB_INDEPENDENT_NSFW_ZONE_RETIRED = True  # 架构目标;经典壳引擎台残债另见决策卡
ACCOUNT_FLAG_NO_LONGER_ALLOWS = True
REQUEST_HEADER = "X-NSFW"
REQUEST_HEADER_VALUE = "1"
UNDERAGE_HARD_BLOCK = True
FAIL_CLOSED_WITHOUT_HEADER = True
