import json

d = json.load(open("test-results-prod/ux-metrics.json"))
print("== 视图 CLS / LCP ==")
for v in d["viewMetrics"]:
    print(f"  {v['view']:12s} cls={v['cls']:<6} lcp={v['lcpMs']}ms load={v['loadMs']}ms")
print("== DI 菜单切换时延 ==")
for i in d["interactionMetrics"]:
    if "sidebar" in i["view"] or "侧栏" in i["action"]:
        print(f"  {i['action']:24s} {i['latencyMs']}ms ok={i['success']}")
print("== a11y 键盘探测 ==")
for a in d["a11yMetrics"]:
    k = a["keyboard"]
    print(
        f"  {a['view']:12s} viol={a['violations']} focusable={k['focusableCount']} "
        f"tabVisible={k['tabReachesVisible']} firstTab={k['firstTabTarget']!r}"
    )
