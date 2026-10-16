#!/usr/bin/env python3
"""2318：23:18 铺满优先禁垫边 + 沉思/温柔 Qwen-Edit-2509 + 撤回 side_base；锁威严/冷酷/惊恐/果断；:8262；final_review/deliver=false。"""
from __future__ import annotations
import asyncio, hashlib, json, os, sys, time
from pathlib import Path
sys.path.insert(0, "/home/merlin/toiv/api")
OUT = Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_2318")
SRC = Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_1703")
PREV2023 = Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_2023")
PREV1915 = Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_1915_final")
PREV2028 = Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_2028")
MASTERS = Path("/home/merlin/toiv/tmp/toiv_report_sheet_masters_1645")
RB = PREV2023 / "out" / "rejects_b"
OUT_DIR = OUT / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)
LOG = OUT / "run_2318.log"
WORKER = "http://100.68.100.90:8262"
TEST_CID = "test2318_anime_nointake"
SEED = 10042318
COMMIT = "PENDING"
os.environ["TOIV_SHEET_REJECT_DIR"] = str(OUT_DIR / "rejects")
Path(os.environ["TOIV_SHEET_REJECT_DIR"]).mkdir(parents=True, exist_ok=True)
os.environ.pop("TOIV_SHEET_FACE_BLEND", None)
os.environ.pop("TOIV_SHEET_SIDE_DEBLUR", None)
os.environ.pop("TOIV_SHEET_SIDE_HIST_MATCH", None)

def log(msg: str) -> None:
    line = "[" + time.strftime("%Y-%m-%d %H:%M:%S") + "] " + msg
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")

def md5b(b: bytes) -> str:
    return hashlib.md5(b).hexdigest()

def load_expr_base(i: int) -> bytes:
    if i == 4:
        return (RB / "rejected_10032056_expr_4.png").read_bytes()
    for name in (f"rejected_10032056_all_expr_{i}.png", f"rejected_10032056_expr_{i}.png"):
        p = RB / name
        if p.exists():
            return p.read_bytes()
    raise FileNotFoundError(f"expr_{i}")

def resolve_lock_png(candidates: list[Path]) -> Path:
    for p in candidates:
        if p.is_file():
            return p
    raise FileNotFoundError("none of " + ", ".join(str(c) for c in candidates))

async def clear_8262() -> None:
    import httpx
    async with httpx.AsyncClient(timeout=20.0) as client:
        await client.post(f"{WORKER}/queue", json={"clear": "pending"})
        q = (await client.get(f"{WORKER}/queue")).json()
        log("8262 pending=%d running=%d" % (len(q.get("queue_pending") or []), len(q.get("queue_running") or [])))

async def main() -> None:
    from PIL import Image
    from io import BytesIO
    from app.comfy.pool import WorkerPool
    from app.services.studio.character_sheet import (
        CharacterSheetError, SheetMeta, generate_character_sheet,
        assert_panel_coverage, measure_face_height_frac,
        crop_face_slot_from_master_with_meta, build_costume_collage_from_portrait,
        assert_expr_base_face_area, _EXPR_KEYS, _EXPR_LABELS,
        expr_cell_content_coverage, _studio_pad_edge_frac, vlm_sticky_evidence,
        LAYOUT,
    )
    global COMMIT
    try:
        import subprocess
        COMMIT = subprocess.check_output(
            ["git", "-C", "/home/merlin/toiv/api", "rev-parse", "--short", "HEAD"],
            text=True,
        ).strip()
    except Exception:
        COMMIT = "unknown"

    await clear_8262()
    approved = (SRC / "out" / "approved_portrait_10031947.png").read_bytes()
    assert_panel_coverage(approved)
    back_p = MASTERS / "master_back_f77b74832045.png"
    side_master = (MASTERS / "master_side_230c0d958e.png").read_bytes()
    pre, meta = crop_face_slot_from_master_with_meta(
        side_master, slot="face_three_quarter", size=768
    )
    (OUT_DIR / "pre_face_three_quarter_lanczos.png").write_bytes(pre)
    log("pre side Lanczos meta=%s md5=%s" % (
        {k: meta.get(k) for k in ("native_side", "upscale", "face_frac", "route")},
        md5b(pre)[:12]))
    panels = {
        "portrait": approved,
        "front": (SRC / "override" / "front.png").read_bytes(),
        "side": side_master,
        "back": back_p.read_bytes(),
    }
    costume = build_costume_collage_from_portrait(panels["portrait"], style="anime")
    panels["costume"] = costume
    (OUT_DIR / "pre_costume.png").write_bytes(costume)

    expr0_p = resolve_lock_png([
        PREV1915 / "out" / "expr_0_inpaint_ok_10041930.png",
        OUT / "locks" / "expr_0_inpaint_ok_10041930.png",
    ])
    expr1_p = resolve_lock_png([
        PREV2028 / "expr_1_ok.png",
        PREV2028 / "out" / "expr_1_inpaint_ok_10042028.png",
        OUT / "locks" / "expr_1_ok.png",
    ])
    expr5_p = resolve_lock_png([
        PREV2028 / "out" / "expr_5_inpaint_ok_10042028.png",
        PREV2028 / "expr_5_ok.png",
        OUT / "locks" / "expr_5_inpaint_ok_10042028.png",
    ])
    expr4_b = load_expr_base(4)
    assert md5b(expr4_b).startswith("27dfb6a052ea"), md5b(expr4_b)

    panels["expr_0"] = expr0_p.read_bytes()
    panels["expr_1"] = expr1_p.read_bytes()
    panels["expr_4"] = expr4_b
    panels["expr_5"] = expr5_p.read_bytes()

    expr_lock_meta = {
        "expr_0": {
            "approved_by_parent": True,
            "source": "1915/1930",
            "note": "locked 威严",
            "path": str(expr0_p),
        },
        "expr_1": {
            "approved_by_parent": True,
            "source": "2028/expr_1_ok",
            "note": "locked 冷酷",
            "path": str(expr1_p),
        },
        "expr_4": {
            "approved_by_parent": False,
            "source": "2023b/rejected_10032056_expr_4",
            "note": "locked panic route 27dfb6a052ea",
            "path": str(RB / "rejected_10032056_expr_4.png"),
        },
        "expr_5": {
            "approved_by_parent": True,
            "source": "2028/expr_5_inpaint_ok",
            "note": "locked 果断",
            "path": str(expr5_p),
        },
    }
    for ek, meta_l in expr_lock_meta.items():
        log("lock %s approved_by_parent=%s md5=%s src=%s" % (
            ek, meta_l["approved_by_parent"], md5b(panels[ek])[:12], meta_l["source"]))

    expr_bases = {}
    for i in range(6):
        k = f"expr_{i}"
        b = load_expr_base(i)
        fixed, area = assert_expr_base_face_area(b, expr_key=k, min_area=0.15)
        expr_bases[k] = fixed
        (OUT_DIR / ("base_%s.png" % k)).write_bytes(fixed)
        log("base %s md5=%s area=%.3f" % (k, md5b(fixed)[:12], area))

    meta_s = SheetMeta(
        name="林夏", style="anime", height_cm=168, role="便利店员", personality="克制、冷静",
        design_notes="",
        colors=["#E8C4A8", "#5A6A7A", "#D4D3D8", "#C98A7A", "#2C2C34", "#1A1A1E"],
        visual_prompt="young East Asian woman Lin Xia, jet black hair, slate gray #5A6A7A long hooded raincoat, black pantyhose boots, plain chest, hood down, full body",
        description="林夏 二次元",
    )
    pool = WorkerPool.from_urls([WORKER], timeout=180.0)
    log("start seed=%s cid=%s commit=%s worker=%s locked=%s regen=[expr_2,expr_3]" % (
        SEED, TEST_CID, COMMIT, WORKER, sorted(expr_lock_meta.keys())))
    t0 = time.time()
    err = None
    try:
        url, png, panel_urls = await generate_character_sheet(
            character_id=TEST_CID, meta=meta_s, pool=pool, worker=WORKER, seed=SEED,
            panels_override=panels, allow_reuse_refs=False, expr_base_panels=expr_bases,
            expr_lock_meta=expr_lock_meta,
        )
    except CharacterSheetError as e:
        err = str(e); log("FAIL CharacterSheetError: %s" % e)
        url, png, panel_urls = "", b"", {}
    except Exception as e:
        err = repr(e); log("FAIL Exc: %s" % e)
        url, png, panel_urls = "", b"", {}
    elapsed = round(time.time() - t0, 1)
    if png:
        (OUT_DIR / "sheet.png").write_bytes(png)
        (OUT / "sheet.png").write_bytes(png)

    rej = Path(os.environ["TOIV_SHEET_REJECT_DIR"])
    fb = rej / ("expr_grid_fallback_%d.txt" % SEED)
    expr_fallback = fb.exists()
    if fb.exists():
        (OUT_DIR / "expr_grid_fallback.txt").write_text(fb.read_text(encoding="utf-8"), encoding="utf-8")

    # side_base must NOT exist
    side_hits = list(rej.glob("expr_2_side_base_*"))
    if side_hits:
        log("WARN unexpected side_base files: %s" % [str(p) for p in side_hits])

    vlm_by_key = {}
    face_fracs = {}
    coverages = {}
    pad_fracs = {}
    locked_info = {}
    qedit_meta = {}
    for ek in _EXPR_KEYS:
        jp = rej / f"{ek}_vlm_{SEED}.json"
        if jp.exists():
            try:
                vlm_by_key[ek] = json.loads(jp.read_text(encoding="utf-8"))
            except Exception as e:
                vlm_by_key[ek] = {"error": str(e)}
        lp = rej / f"{ek}_locked_{SEED}.json"
        if lp.exists():
            try:
                locked_info[ek] = json.loads(lp.read_text(encoding="utf-8"))
            except Exception as e:
                locked_info[ek] = {"error": str(e)}
        qm = rej / f"{ek}_qedit_meta_{SEED}.json"
        if qm.exists():
            try:
                qedit_meta[ek] = json.loads(qm.read_text(encoding="utf-8"))
            except Exception as e:
                qedit_meta[ek] = {"error": str(e)}
        cp = rej / f"{ek}_vlm_cell_{SEED}.png"
        if not cp.exists():
            cp = rej / f"{ek}_qedit_ok_{SEED}.png"
        if not cp.exists():
            cp = rej / f"{ek}_inpaint_ok_{SEED}.png"
        if not cp.exists():
            cp = rej / f"{ek}_locked_{SEED}.png"
        if cp.exists():
            b = cp.read_bytes()
            face_fracs[ek] = measure_face_height_frac(b)
            coverages[ek] = expr_cell_content_coverage(b)
            pad_fracs[ek] = _studio_pad_edge_frac(b)
            imc = Image.open(BytesIO(b)).convert("RGB")
            imc.resize((256, 256), Image.Resampling.LANCZOS).save(
                OUT_DIR / f"{ek}_cell_thumb.jpg", quality=85
            )

    if png:
        sim = Image.open(BytesIO(png)).convert("RGB")
        ex, ey, ew, eh = LAYOUT["expressions"]
        content = sim.crop((ex + 8, ey + 32, ex + ew - 8, ey + eh - 8))
        content.save(OUT_DIR / "expr_region.png")
        cols, rows = 3, 2
        cw2, ch2 = content.size
        cell_w = cw2 // cols
        cell_h = ch2 // rows
        label_h = 44
        img_h = max(48, cell_h - label_h)
        for i, ek in enumerate(_EXPR_KEYS):
            row, col = divmod(i, cols)
            cell = content.crop((
                col * cell_w + 3, row * cell_h + 3,
                col * cell_w + cell_w - 3, row * cell_h + img_h - 3,
            ))
            cell.save(OUT_DIR / ("%s_cell.png" % ek))
            cell.resize((256, 256), Image.Resampling.LANCZOS).save(
                OUT_DIR / ("%s_cell_thumb.jpg" % ek), quality=85
            )
            buf = BytesIO(); cell.save(buf, format="PNG")
            b = buf.getvalue()
            if ek not in face_fracs:
                face_fracs[ek] = measure_face_height_frac(b)
            coverages[ek] = expr_cell_content_coverage(b)
            pad_fracs[ek] = _studio_pad_edge_frac(b)
        sim.resize((600, int(600 * sim.height / sim.width)), Image.Resampling.LANCZOS).save(
            OUT / "sheet_thumb.jpg", quality=85
        )

    for p in list(rej.glob("*qedit*")) + list(rej.glob("*inpaint*")) + list(rej.glob(f"*vlm*{SEED}*")) + list(rej.glob(f"*locked*{SEED}*")):
        dest = OUT_DIR / p.name
        try:
            if p.suffix in (".txt", ".json"):
                dest.write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
            else:
                dest.write_bytes(p.read_bytes())
        except Exception:
            pass

    vlm_summary = {}
    for i, ek in enumerate(_EXPR_KEYS):
        lab = _EXPR_LABELS[i]
        vr = vlm_by_key.get(ek) or {}
        lk = locked_info.get(ek) or {}
        vlm_summary[ek] = {
            "want": lab,
            "label": vr.get("label"),
            "scores": vr.get("scores"),
            "smiling": vr.get("smiling"),
            "model": vr.get("model"),
            "match": (vr.get("label") == lab) if vr else None,
            "face_height_frac": face_fracs.get(ek),
            "content_coverage": coverages.get(ek),
            "studio_pad_frac": pad_fracs.get(ek),
            "locked": bool(lk) or ek in expr_lock_meta,
            "approved_by_parent": bool(lk.get("approved_by_parent") if lk else expr_lock_meta.get(ek, {}).get("approved_by_parent")),
            "lock_source": (lk.get("source") if lk else None) or expr_lock_meta.get(ek, {}).get("source"),
            "skipped_inpaint": bool(lk.get("skipped_inpaint")) if lk else (ek in expr_lock_meta),
            "qedit": qedit_meta.get(ek),
        }

    fracs = [v for v in face_fracs.values() if isinstance(v, (int, float))]
    covs = [v for v in coverages.values() if isinstance(v, (int, float))]
    sticky = {}
    try:
        sticky = vlm_sticky_evidence()
    except Exception as e:
        sticky = {"error": str(e)}

    gate = {
        "expr_fallback": bool(expr_fallback),
        "vlm": vlm_summary,
        "locked": locked_info,
        "qedit_meta": qedit_meta,
        "face_frac_range": [min(fracs), max(fracs)] if fracs else None,
        "face_fracs": face_fracs,
        "content_coverages": coverages,
        "coverage_min": min(covs) if covs else None,
        "studio_pad_fracs": pad_fracs,
        "side_base_present": bool(side_hits),
        "error": err,
        "final_review": False,
        "deliver": False,
        "commit": COMMIT,
        "seed": SEED,
        "elapsed": elapsed,
        "vlm_sticky": sticky,
        "regen_exprs": ["expr_2", "expr_3"],
        "plan": "2026-10-04 23:18 fill-first no pad + contemplative/gentle Qwen-Edit-2509 + no side_base",
    }
    (OUT / "gate_summary_2318.json").write_text(
        json.dumps(gate, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT_DIR / "gate_summary_2318.json").write_text(
        json.dumps(gate, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # SUMMARY
    lines = [
        "# Sheet anime 2318 SUMMARY",
        "",
        f"- seed: {SEED}",
        f"- cid: {TEST_CID}",
        f"- commit: {COMMIT}",
        f"- worker: {WORKER}",
        f"- elapsed_s: {elapsed}",
        f"- error: {err}",
        f"- expr_fallback: {expr_fallback}",
        f"- final_review: false",
        f"- deliver: false",
        f"- side_base_present: {bool(side_hits)}",
        f"- coverage_min: {gate.get('coverage_min')}",
        f"- face_frac_range: {gate.get('face_frac_range')}",
        "",
        "## Expressions",
    ]
    for ek, info in vlm_summary.items():
        lines.append(
            f"- {ek} want={info['want']} label={info.get('label')} match={info.get('match')} "
            f"locked={info.get('locked')} cov={info.get('content_coverage')} "
            f"face_h={info.get('face_height_frac')} pad={info.get('studio_pad_frac')} "
            f"qedit={bool(info.get('qedit'))} smiling={info.get('smiling')}"
        )
    lines += ["", f"## Evidence", f"- {OUT}", f"- {OUT_DIR}"]
    (OUT / "SUMMARY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log("done elapsed=%s err=%s fallback=%s cov_min=%s" % (
        elapsed, err, expr_fallback, gate.get("coverage_min")))
    print(json.dumps({
        "elapsed": elapsed, "error": err, "fallback": expr_fallback,
        "sheet": bool(png), "coverage_min": gate.get("coverage_min"),
        "commit": COMMIT,
    }, ensure_ascii=False))

if __name__ == "__main__":
    asyncio.run(main())
