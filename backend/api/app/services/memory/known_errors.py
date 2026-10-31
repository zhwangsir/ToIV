"""FU4 known-errors skill 文档层:工具域→已知错误条目模型 + skill 文本渲染。

理念来自 agent skill 三件套规范的「症状/根因/验证」条目形态(自研重写,
不照抄任何第三方 skill 文本)。条目只沉淀「会重复踩的坑」:每个条目必须给出
可执行的验证步骤(verification),让 agent 在写「已验证」之前有硬门槛。

内置种子覆盖三个真实工具域,内容从 ToIV 集群运维记忆(AGENTS.md §六 易错点)
提炼改写而来,不照抄原文大段:
- comfy-worker:ComfyUI 多实例舰队的调度/校验坑
- face-gate:人脸分门控候选筛选的坑
- svml-import:SVML 词锚脚本导入的坑
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


class KnownErrorValue(ValueError):
    """条目字段缺失或非法。"""


@dataclass(frozen=True)
class KnownError:
    """一条已知错误:现象 / 根因 / 验证三段缺一不可。"""

    domain: str
    title: str
    symptom: str
    root_cause: str
    verification: str

    def __post_init__(self) -> None:
        for fname in ("domain", "title", "symptom", "root_cause", "verification"):
            val = getattr(self, fname)
            if not isinstance(val, str) or not val.strip():
                raise KnownErrorValue(f"KnownError.{fname} 必须非空字符串")


def render_skill_md(entries: Sequence[KnownError]) -> str:
    """渲染成 agent 可读的 skill markdown:按域分组,条目固定三段式。"""
    if not entries:
        raise KnownErrorValue("entries 不能为空")
    lines: list[str] = [
        "---",
        "name: toiv-known-errors",
        "description: ToIV 工具域已知错误速查(symptom/root_cause/verification)。",
        "---",
        "",
        "# Known Errors",
        "",
    ]
    seen_domains: list[str] = []
    for e in entries:
        if not isinstance(e, KnownError):
            raise KnownErrorValue("entries 必须全是 KnownError")
        if e.domain not in seen_domains:
            seen_domains.append(e.domain)
    for domain in seen_domains:
        lines.append(f"## {domain}")
        lines.append("")
        for e in entries:
            if e.domain != domain:
                continue
            lines.append(f"### {e.title}")
            lines.append("")
            lines.append(f"- **Symptom**: {e.symptom}")
            lines.append(f"- **Root cause**: {e.root_cause}")
            lines.append(f"- **Verification**: {e.verification}")
            lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 内置种子:三域条目(AGENTS §六 提炼改写;出处注释保留)
# ---------------------------------------------------------------------------

SEED_ENTRIES: tuple[KnownError, ...] = (
    KnownError(
        domain="comfy-worker",
        title="新专用实例作业成功但产物 502",
        symptom=(
            "新加的专用 ComfyUI 实例跑图报成功,但作业产物取回 502,"
            "DB 侧只见完成标记不见文件。"
        ),
        root_cause=(
            "worker 解析表(deps.resolve_worker)没登记新实例的精确匹配规则,"
            "调度器按旧规则找后端找不到,回写阶段拿不到产物。"
        ),
        verification=(
            "先查 /history/{pid} 确认 ComfyUI 侧产物真实存在;再核 "
            "resolve_worker 的匹配键与新实例 UUID/别名逐一对应;"
            "锁卡用 GPU UUID 而非 CUDA 数字索引,起服后查 compute-apps 复核。"
        ),
    ),
    KnownError(
        domain="comfy-worker",
        title="专用分支把路由错伪装成权重不兼容",
        symptom=(
            "走专用实例分支的图报「权重不兼容/fp8 加载失败」,换权重文件无效,"
            "同图丢通用池却能跑。"
        ),
        root_cause=(
            "专用分支按 class_type 前缀直接 return,required 组件从不校验,"
            "真实原因是指派错了实例,combo_repair 把路由错误包装成了权重问题。"
        ),
        verification=(
            "对照 class_type 前缀与实例分支的对应关系;专用分支 return 前"
            "显式校验 required 不满足则穿透 pool;h3_like/qwen_edit_like/"
            "animate2 三条分支同法复查;换权重前先证路由对。"
        ),
    ),
    KnownError(
        domain="comfy-worker",
        title="节点包注册后部分实例行为依旧",
        symptom=(
            "装完/更新节点包后,舰队里部分实例仍报缺节点或自定义节点数不对。"
        ),
        root_cause=(
            "节点包变更只在磁盘生效,未逐实例重启;或实例间共享 user 配置被"
            "并发写坏,注册回滚。"
        ),
        verification=(
            "逐实例重启(必须串行,禁并行)后逐个查 object_info 的节点类集合,"
            "节点总数下降即回滚;文件存在≠生效,以 object_info 键集合为准。"
        ),
    ),
    KnownError(
        domain="face-gate",
        title="候选全被 face_gate 门控拦下",
        symptom="候选挑选结果为空或大量落选,note 里出现 face_gate 低于阈值的标记。",
        root_cause=(
            "人脸均分阈值相对素材过严(侧脸/遮挡/小脸帧天然低分),"
            "或门控用错了分母/分辨率档。"
        ),
        verification=(
            "打印被拦候选的人脸分分布看是否整段卡在阈值下沿;换阈值前后对照"
            "结果是否变化(过滤参数要换值自证);检查打分分辨率与目标一致。"
        ),
    ),
    KnownError(
        domain="face-gate",
        title="人脸分通过但下游仍拒收",
        symptom="face_gate 门控放行的候选,在后续合成/审校环节仍被判人脸质量不合格。",
        root_cause=(
            "门控分与下游判定口径不一致(单帧均分 vs 逐帧最低分),"
            "或参考图与生成图的人脸对齐差异没进门控维度。"
        ),
        verification=(
            "取同一批候选分别跑门控与下游判定,对比逐样本结论找分歧点;"
            "明确门控口径(均分/最低分/对齐分)后只留一个裁判口径。"
        ),
    ),
    KnownError(
        domain="svml-import",
        title="词锚导入后时长节奏错乱",
        symptom="SVML 导入后镜头时长集中压在下限/上限,口播节奏与预期不符。",
        root_cause=(
            "拍文本字数估时是粗估(约 4~5 字/秒取保守值),超短/超长拍被"
            "夹到 [2,15] 秒边界;显式 duration 未写时长被估算值覆盖。"
        ),
        verification=(
            "对照导出 shot 的 duration_sec 与源拍字数;写了显式 duration 的拍"
            "必须以显式值为准;改词后走词锚重排而非手改秒数。"
        ),
    ),
    KnownError(
        domain="svml-import",
        title="词锚语法报错中断整篇导入",
        symptom="parse 抛错指向锚点配对问题,整篇脚本一个分镜都进不去。",
        root_cause=(
            "词锚 @{名}…@{/名} 未闭合、闭合名与开启名不一致,或剥锚后"
            "说话人前缀与正文边界被锚文干扰。"
        ),
        verification=(
            "报错先定位锚名;剥锚(strip_anchors)与拍切分(parse_beats)分别"
            "单测最小复现段;修源文而非放宽解析器容忍度(宽容解析=静默吞错)。"
        ),
    ),
)
