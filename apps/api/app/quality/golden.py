"""黄金回归集注册表(P3)。

内置 manifest:
· zhuxian-25shots   — 诛仙 25 镜 5min 竖屏 9:16 短剧(2026-08-15 全链路实证)。
  仅记元数据,不内嵌生产库分镜数据(测试不连生产库);用途:质量门回归基准。
· silent-eclipse-pv — Editorial-MG PV 20s/30s 双黄金稿,指向
  app/skills/editorial-mg-pv/evals/golden/ 下的正典文件(30s.txt / 20s.txt)。

自定义集合经 register_golden() 挂载后,load_golden(name) 即可取用;
未知名抛 KeyError(消息附已注册名单)。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

_GOLDEN_DIR = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "editorial-mg-pv"
    / "evals"
    / "golden"
)


@dataclass(frozen=True)
class GoldenCase:
    """单条黄金样本。path 为磁盘绝对路径;内容读取由调用方自决。"""

    id: str
    note: str = ""
    path: str = ""
    metadata: dict = field(default_factory=dict)

    def exists(self) -> bool:
        """path 非空且文件真实存在。"""
        return bool(self.path) and Path(self.path).is_file()

    def read_text(self, encoding: str = "utf-8") -> str:
        """读取样本全文;path 缺失时抛 FileNotFoundError。"""
        if not self.path:
            raise FileNotFoundError(f"GoldenCase {self.id} 无 path(元数据壳)")
        return Path(self.path).read_text(encoding=encoding)


@dataclass(frozen=True)
class GoldenSet:
    """一组黄金样本 + 元数据(项目特征/实证日期/用途等)。"""

    name: str
    description: str = ""
    cases: tuple[GoldenCase, ...] = ()
    metadata: dict = field(default_factory=dict)


_REGISTRY: dict[str, GoldenSet] = {}


def register_golden(gset: GoldenSet) -> None:
    """挂载(或覆盖)一个黄金集;自定义集合经此接入。"""
    _REGISTRY[gset.name] = gset


def load_golden(name: str) -> GoldenSet:
    """按名加载黄金集;未知名抛 KeyError。"""
    try:
        return _REGISTRY[name]
    except KeyError:
        raise KeyError(f"未知黄金集: {name!r}(已注册: {sorted(_REGISTRY)})") from None


def list_golden() -> list[GoldenSet]:
    """全部已注册黄金集,按 name 排序,确定性输出。"""
    return [_REGISTRY[k] for k in sorted(_REGISTRY)]


# ── 内置 manifest ────────────────────────────────────────────────────────
register_golden(
    GoldenSet(
        name="zhuxian-25shots",
        description="诛仙 25 镜 5min 竖屏真人短剧分镜链(2026-08-15 全链路实证)",
        cases=(),  # 不内嵌生产库数据;分镜明细以生产库为准,此处仅元数据
        metadata={
            "project": "诛仙",
            "shot_count": 25,
            "duration": "5min",
            "aspect": "9:16",
            "verified": "2026-08-15",
            "source": "生产库(不内嵌;测试不连生产库)",
            "purpose": "质量门回归基准",
        },
    )
)

register_golden(
    GoldenSet(
        name="silent-eclipse-pv",
        description="Editorial-MG PV 双黄金稿(20s 总导演提示词 + 30s 完整视频生成提示词)",
        cases=(
            GoldenCase(
                id="silent-eclipse-30s",
                note="30s 双段完整生成提示词:猩红刀痕缝合 + 严格限制负面清单",
                path=str(_GOLDEN_DIR / "30s.txt"),
                metadata={"duration": 30, "aspect": "16:9", "segments": 2},
            ),
            GoldenCase(
                id="silent-eclipse-20s",
                note="20s 双 10s 总导演提示词:共享帧重叠 + 转场优先链",
                path=str(_GOLDEN_DIR / "20s.txt"),
                metadata={"duration": 20, "aspect": "16:9", "segments": 2},
            ),
        ),
        metadata={
            "title": "SILENT ECLIPSE",
            "style": "纯二维日系硬边赛璐璐 × Editorial Motion Graphics",
            "purpose": "editorial-mg-pv 技能结构对齐与回归基准",
        },
    )
)
