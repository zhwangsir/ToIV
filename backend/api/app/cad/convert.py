"""CAD 平面图转换:DWG/DXF → 干净线稿 PNG(ControlNet 控制图)+ 墙/机柜几何(3D 用)。

链路(经数据中心 DWG 实测):
  DWG --dwg2dxf(libredwg)--> DXF --ezdxf.recover--> 抽线段(爆破 INSERT 块/跳坏块)
    --网格密度定位主图簇--> 渲染裁剪线稿 + 按图层抽 WALL/机柜几何

输入可为 .dwg / .dxf / 图片(.png/.jpg —— 直接当控制图,不转换)。纯 CPU,跑在 api 容器。
"""
from __future__ import annotations

import collections
import math
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# 墙/机柜的图层名(数据中心实测;住宅图层名不同,WALL 类按常见名兜底匹配)
_WALL_LAYERS = {"WALL", "STAIR", "3T_GLASS", "A-WALL", "墙", "建筑-墙", "WALL_1", "Q_WALL"}
_RACK_LAYERS = {"机柜层", "002-设备机架", "设备机架", "设备", "K-设备基础", "设备基础", "FURNITURE", "家具"}
_WALL_HINTS = ("wall", "墙", "partition", "column", "柱")  # 图层名含这些 → 当墙体
_RACK_HINTS = ("机柜", "设备", "rack", "furnitur", "家具", "设施")


@dataclass(frozen=True)
class ConvertResult:
    line_image: Path  # 干净线稿 PNG(控制图)
    geometry: dict  # {walls:[[x1,y1,x2,y2]...], racks:[...], w, h}(米,居中)
    width: int
    height: int
    n_segments: int


def _dwg_to_dxf(dwg: Path, dxf: Path) -> None:
    if shutil.which("dwg2dxf") is None:
        raise RuntimeError("DWG 转换组件(dwg2dxf)未就绪,请改上传 DXF 或平面图片")
    proc = subprocess.run(
        ["dwg2dxf", "-y", "-o", str(dxf), str(dwg)],
        capture_output=True, text=True, timeout=180,
    )
    if not dxf.exists() or dxf.stat().st_size == 0:
        raise RuntimeError(f"DWG→DXF 失败:{(proc.stderr or '')[-300:]}")


def _classify(layer: str) -> str:
    """图层 → wall / rack / other。"""
    if layer in _WALL_LAYERS:
        return "wall"
    if layer in _RACK_LAYERS:
        return "rack"
    low = layer.lower()
    if any(h in low for h in _RACK_HINTS):
        return "rack"
    if any(h in low for h in _WALL_HINTS):
        return "wall"
    return "other"


def _extract_segments(dxf: Path) -> list[tuple]:
    """ezdxf.recover 抽全部线段:返回 [(cls, x1,y1,x2,y2), ...]。"""
    from ezdxf import recover

    doc, _auditor = recover.readfile(str(dxf))
    msp = doc.modelspace()
    segs: list[tuple] = []

    def add(cls: str, a, b) -> None:
        segs.append((cls, float(a[0]), float(a[1]), float(b[0]), float(b[1])))

    def handle(e, layer: str) -> None:
        cls = _classify(layer)
        t = e.dxftype()
        if t == "LINE":
            add(cls, e.dxf.start, e.dxf.end)
        elif t == "LWPOLYLINE":
            pts = [(p[0], p[1]) for p in e.get_points()]
            for i in range(len(pts) - 1):
                add(cls, pts[i], pts[i + 1])
            if e.closed and len(pts) > 2:
                add(cls, pts[-1], pts[0])
        elif t == "POLYLINE":
            pts = [(v.dxf.location[0], v.dxf.location[1]) for v in e.vertices]
            for i in range(len(pts) - 1):
                add(cls, pts[i], pts[i + 1])
        elif t == "CIRCLE":
            c, r = e.dxf.center, e.dxf.radius
            p = [(c[0] + r * math.cos(a), c[1] + r * math.sin(a)) for a in [i * math.pi / 12 for i in range(25)]]
            for i in range(len(p) - 1):
                add(cls, p[i], p[i + 1])
        elif t == "ARC":
            c, r = e.dxf.center, e.dxf.radius
            a0, a1 = math.radians(e.dxf.start_angle), math.radians(e.dxf.end_angle)
            if a1 < a0:
                a1 += 2 * math.pi
            steps = max(2, int((a1 - a0) / (math.pi / 12)))
            p = [(c[0] + r * math.cos(a0 + (a1 - a0) * i / steps), c[1] + r * math.sin(a0 + (a1 - a0) * i / steps)) for i in range(steps + 1)]
            for i in range(len(p) - 1):
                add(cls, p[i], p[i + 1])

    for e in msp:
        try:
            ly = e.dxf.layer if e.dxf.hasattr("layer") else "0"
            if e.dxftype() == "INSERT":
                for ve in e.virtual_entities():
                    try:
                        handle(ve, ve.dxf.layer if ve.dxf.hasattr("layer") else ly)
                    except Exception:  # noqa: BLE001 — 跳过坏块,不中断
                        pass
            else:
                handle(e, ly)
        except Exception:  # noqa: BLE001
            pass
    return segs


def _main_cluster(segs: list[tuple], grid: int = 24) -> tuple[float, float, float, float]:
    """网格密度定位最密内容簇(DWG 常多图散落空白)→ 返回主簇 bbox。"""
    xs = [s[1] for s in segs] + [s[3] for s in segs]
    ys = [s[2] for s in segs] + [s[4] for s in segs]
    gx0, gx1, gy0, gy1 = min(xs), max(xs), min(ys), max(ys)
    spanx, spany = (gx1 - gx0) or 1, (gy1 - gy0) or 1
    cells: collections.Counter = collections.Counter()
    for x, y in zip(xs, ys):
        cx = min(grid - 1, int((x - gx0) / spanx * grid))
        cy = min(grid - 1, int((y - gy0) / spany * grid))
        cells[(cx, cy)] += 1
    if not cells:
        return gx0, gx1, gy0, gy1
    # 最密格周围扩 ±2 格作主簇
    (mcx, mcy), _ = cells.most_common(1)[0]
    cw, ch = spanx / grid, spany / grid
    bx0 = gx0 + cw * max(0, mcx - 2)
    bx1 = gx0 + cw * min(grid, mcx + 3)
    by0 = gy0 + ch * max(0, mcy - 2)
    by1 = gy0 + ch * min(grid, mcy + 3)
    # 把落入该范围的线段实际范围收紧
    inx = [s for s in segs if bx0 <= (s[1] + s[3]) / 2 <= bx1 and by0 <= (s[2] + s[4]) / 2 <= by1]
    if len(inx) > 50:
        xs2 = [s[1] for s in inx] + [s[3] for s in inx]
        ys2 = [s[2] for s in inx] + [s[4] for s in inx]
        return min(xs2), max(xs2), min(ys2), max(ys2)
    return bx0, bx1, by0, by1


def _render_lineart(segs: list[tuple], bbox: tuple, out: Path, max_px: int = 1344) -> tuple[int, int]:
    """渲染主簇线稿(白底黑线),长边 max_px,保持比例。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    x0, x1, y0, y1 = bbox
    w, h = (x1 - x0) or 1, (y1 - y0) or 1
    if w >= h:
        px_w, px_h = max_px, max(256, int(max_px * h / w))
    else:
        px_h, px_w = max_px, max(256, int(max_px * w / h))
    pad = max(w, h) * 0.02
    lines = [[(s[1], s[2]), (s[3], s[4])] for s in segs
             if x0 - pad <= (s[1] + s[3]) / 2 <= x1 + pad and y0 - pad <= (s[2] + s[4]) / 2 <= y1 + pad]
    fig = plt.figure(figsize=(px_w / 100, px_h / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.add_collection(LineCollection(lines, colors="black", linewidths=0.6))
    ax.set_xlim(x0 - pad, x1 + pad)
    ax.set_ylim(y0 - pad, y1 + pad)
    ax.set_aspect("auto")
    ax.axis("off")
    fig.savefig(str(out), dpi=100, facecolor="white")
    plt.close(fig)
    return px_w, px_h


def _extract_geometry(segs: list[tuple], bbox: tuple) -> dict:
    """主簇内 WALL/机柜几何 → 居中、/1000(米)、保留 >0.8m 段,供 3D/轴测。"""
    x0, x1, y0, y1 = bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    def collect(cls: str) -> list[list[float]]:
        out = []
        for c, sx, sy, ex, ey in segs:
            if c != cls:
                continue
            if not (x0 <= (sx + ex) / 2 <= x1 and y0 <= (sy + ey) / 2 <= y1):
                continue
            if math.hypot(ex - sx, ey - sy) <= 800:
                continue
            out.append([round((sx - cx) / 1000, 1), round((sy - cy) / 1000, 1),
                        round((ex - cx) / 1000, 1), round((ey - cy) / 1000, 1)])
        return out

    return {"walls": collect("wall"), "racks": collect("rack"),
            "w": round((x1 - x0) / 1000, 1), "h": round((y1 - y0) / 1000, 1)}


def convert(input_path: Path, out_png: Path) -> ConvertResult:
    """主入口:输入 DWG/DXF/图片 → 线稿 PNG + 几何。图片输入则直接当控制图(不抽几何)。"""
    ext = input_path.suffix.lower()
    if ext in (".png", ".jpg", ".jpeg", ".webp"):
        shutil.copy2(input_path, out_png)
        return ConvertResult(out_png, {"walls": [], "racks": [], "w": 0, "h": 0}, 0, 0, 0)

    with tempfile.TemporaryDirectory(prefix="cad-") as tmp:
        if ext == ".dwg":
            dxf = Path(tmp) / "in.dxf"
            _dwg_to_dxf(input_path, dxf)
        elif ext == ".dxf":
            dxf = input_path
        else:
            raise RuntimeError(f"不支持的格式:{ext}(支持 .dwg/.dxf/图片)")

        segs = _extract_segments(dxf)
        if not segs:
            raise RuntimeError("未从图纸抽到任何几何")
        bbox = _main_cluster(segs)
        pw, ph = _render_lineart(segs, bbox, out_png)
        geo = _extract_geometry(segs, bbox)
    return ConvertResult(out_png, geo, pw, ph, len(segs))
