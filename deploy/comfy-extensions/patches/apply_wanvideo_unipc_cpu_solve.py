#!/usr/bin/env python3
"""把 WanVideoWrapper 的 UniPC 调度器里两处小矩阵 torch.linalg.solve 挪到 CPU。

**为什么**:RH 导入的 Wan2.2 i2v 应用(先导批 25 条里 3 条,Wan2.2 i2v 是 RH 主流通路)
在采样阶段报
    RuntimeError: cusolver error: CUSOLVER_STATUS_INTERNAL_ERROR,
                  when calling `cusolverDnCreate(handle)`
真机 traceback 定位到
    ComfyUI-WanVideoWrapper/wanvideo/schedulers/fm_solvers_unipc.py:643
        rhos_c = torch.linalg.solve(R, b).to(device).to(x.dtype)
以及同文件 :497 的 P 侧同款调用。

R/b 是 UniPC 的 order(≤3)阶小矩阵,本该是 CPU 上瞬间完成的运算;但张量在 CUDA 上,
于是 torch 派给 cusolver,而 cusolverDnCreate 要申请 workspace——此时进程里已经压着
14B 权重 + 1054 个 LoRA patch + 81 帧 432x640(seq 22680)的激活,句柄创建直接失败。

**为什么这样改是安全的**:两处的原代码都在 solve 之后紧跟 `.to(device)`,说明作者本就
预期结果要搬回设备,故在 CPU 上求解不改变语义;小矩阵 CPU 求解精度只会更好。
不是绕过错误,是把一个不该上 GPU 的运算放回 CPU。

**为什么不是环境问题**:同一台机、同一块 GPU0、同一个 torch(2.12.1+cu130, sm_120),
新起进程跑 torch.linalg.svd 完全正常 → cusolver 本身没坏,是长驻进程内存压力下的
句柄创建失败。故不重启实例、不改驱动,只改这两行。

顺带纠正一处误导:报错文本建议用 `torch.backends.cuda.prefer_linalg_library()`,
但本机 torch 2.12 **只有 getter `preferred_linalg_library()`,没有这个 setter**
(实测 AttributeError),照报错提示做会直接崩。

幂等 + 前置校验:上游若改了这两行(文本对不上)就**报错退出而不是硬改**,避免把补丁
打到不认识的代码上。AGENTS D-2 的教训:一次性手工补丁没有守护会静默失效,故补丁脚本入仓。

用法(在 workstation 上跑):
  python3 apply_wanvideo_unipc_cpu_solve.py --dry-run
  python3 apply_wanvideo_unipc_cpu_solve.py --apply
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import time
from pathlib import Path

REL = "custom_nodes/ComfyUI-WanVideoWrapper/wanvideo/schedulers/fm_solvers_unipc.py"
ROOTS = (
    "/opt/ComfyUI",
    "/home/merlin/ComfyUI-h3-eval",
    "/home/merlin/ComfyUI-longcat",
)

# (原文, 替换后)。原文必须逐字匹配,含缩进与换行——对不上就退出,不猜。
EDITS = (
    (
        "                rhos_p = torch.linalg.solve(R[:-1, :-1],\n"
        "                                            b[:-1]).to(device).to(x.dtype)",
        "                rhos_p = torch.linalg.solve(R[:-1, :-1].cpu(),\n"
        "                                            b[:-1].cpu()).to(device).to(x.dtype)",
    ),
    (
        "            rhos_c = torch.linalg.solve(R, b).to(device).to(x.dtype)",
        "            rhos_c = torch.linalg.solve(R.cpu(), b.cpu()).to(device).to(x.dtype)",
    ),
)
MARKER = ".cpu()"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真改文件(默认 dry-run)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--roots", default=",".join(ROOTS), help="逗号分隔的 ComfyUI 根目录")
    args = ap.parse_args()
    dry = not args.apply
    stamp = time.strftime("%Y%m%d-%H%M%S")

    targets = []
    for root in [r.strip() for r in args.roots.split(",") if r.strip()]:
        p = Path(root) / REL
        if p.exists():
            targets.append(p)
        else:
            print(f"  跳过 {root}:未安装 WanVideoWrapper")
    if not targets:
        print("⛔ 一个目标都没找到,检查 --roots")
        return 1

    changed = skipped = 0
    for p in targets:
        src = p.read_text(encoding="utf-8")
        md5 = hashlib.md5(src.encode()).hexdigest()
        already = all(new in src for _, new in EDITS)
        if already:
            print(f"  = 已打过补丁,跳过 {p} (md5 {md5[:8]})")
            skipped += 1
            continue
        # 前置校验:两处原文都必须逐字命中,否则说明上游变了,不能盲改
        missing = [old.strip().splitlines()[0][:60] for old, _ in EDITS if old not in src]
        if missing:
            print(f"  ⛔ 原文对不上,拒绝修改 {p} (md5 {md5[:8]})")
            for m in missing:
                print(f"       缺: {m}")
            print("     上游可能已改版;请人工核对后更新本脚本的 EDITS")
            return 2
        out = src
        for old, new in EDITS:
            out = out.replace(old, new, 1)
        n = sum(1 for _, new in EDITS if new in out)
        if n != len(EDITS):
            print(f"  ⛔ 替换后校验未过({n}/{len(EDITS)}),不写文件 {p}")
            return 3
        print(f"  {'[dry] ' if dry else ''}补丁 {len(EDITS)} 处 → {p} (原 md5 {md5[:8]})")
        if not dry:
            bak = p.with_name(p.name + f".bak-{stamp}")
            shutil.copy2(p, bak)
            p.write_text(out, encoding="utf-8")
            print(f"       备份 → {bak.name}")
            changed += 1

    print(f"\n{'DRY-RUN' if dry else 'APPLY'}:目标 {len(targets)} 份,已打 {skipped} 份,"
          f"本次{'将改' if dry else '已改'} {changed if not dry else len(targets) - skipped} 份")
    if dry:
        print("确认无误后加 --apply。改完需重启对应 ComfyUI 实例才会重新加载模块。")
    else:
        print("⚠️ 必须重启实例才生效(:8196=comfyui-gpu0-alt / :8195+:8264=ComfyUI-h3-eval 两个 unit /"
              " :8197=comfyui-longcat)。重启会打断在跑的生成与烟测,挑空闲窗口。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
