"""几何 → 轴测 / 3D 体量渲染(matplotlib ortho 投影)。墙体高白、机柜矮蓝、薄地面。

层高夸大 ~2× 否则在大底面上太平被地面盖;按几何 bbox 居中(别用裁剪框)。
"""
from __future__ import annotations

from pathlib import Path

_HW, _HR = 18.0, 7.0  # 墙 / 机柜 拉伸高度(已夸大,视觉清晰)


def render_axon(geo: dict, out: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    walls = geo.get("walls", [])
    racks = geo.get("racks", [])
    allseg = walls + racks
    if not allseg:
        raise ValueError("无几何")
    xs = [s[0] for s in allseg] + [s[2] for s in allseg]
    ys = [s[1] for s in allseg] + [s[3] for s in allseg]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    w, h = (maxx - minx) or 1, (maxy - miny) or 1

    def quads(segs, ht):
        return [[(x1 - cx, y1 - cy, 0), (x2 - cx, y2 - cy, 0),
                 (x2 - cx, y2 - cy, ht), (x1 - cx, y1 - cy, ht)] for x1, y1, x2, y2 in segs]

    fig = plt.figure(figsize=(18, 14))
    ax = fig.add_subplot(111, projection="3d")
    m = max(w, h) * 0.06
    ax.add_collection3d(Poly3DCollection(
        [[(-w / 2 - m, -h / 2 - m, -0.3), (w / 2 + m, -h / 2 - m, -0.3),
          (w / 2 + m, h / 2 + m, -0.3), (-w / 2 - m, h / 2 + m, -0.3)]],
        facecolors="#eef1f4", edgecolors="#d6dbe1", linewidths=0.5))
    if racks:
        ax.add_collection3d(Poly3DCollection(quads(racks, _HR), facecolors="#2f6fb2", edgecolors="#1c4a7d", linewidths=0.12))
    ax.add_collection3d(Poly3DCollection(quads(walls, _HW), facecolors="#f7f9fb", edgecolors="#6f7884", linewidths=0.28))
    ax.set_xlim(-w / 2, w / 2)
    ax.set_ylim(-h / 2, h / 2)
    ax.set_zlim(0, _HW * 2.4)
    ax.set_box_aspect((w, h, w * 0.55))
    ax.view_init(elev=35, azim=-50)
    try:
        ax.set_proj_type("ortho")  # 正交=轴测
    except Exception:  # noqa: BLE001 — 老版本 matplotlib 无此方法
        pass
    ax.set_axis_off()
    fig.savefig(str(out), dpi=130, facecolor="white", bbox_inches="tight", pad_inches=0.05)
    plt.close(fig)
