"""Compare rs334 per-population AC/AN: gnomAD API (hgdp:/1kg: ids) vs the HGDP+1KG dense VCF INFO.

Usage: python -I compare_rs334.py <dense_info.tsv> <popnames.txt> <api_r3.json> <api_r4.json>
"""

import json
import sys

info_path, pop_path, r3_path, r4_path = sys.argv[1:5]
pops = [line.strip() for line in open(pop_path) if line.strip()]
fields = open(info_path).read().rstrip("\n").split("\t")
dense = {}
for i, p in enumerate(pops):
    ac, an = fields[7 + 2 * i], fields[8 + 2 * i]
    dense[p] = (int(ac), int(an))
print("dense: pops", len(dense), "sum AC", sum(v[0] for v in dense.values()),
      "sum AN", sum(v[1] for v in dense.values()))

for label, path in (("r3", r3_path), ("r4", r4_path)):
    data = json.load(open(path))["data"]["variant"]["genome"]
    sub = {}
    for row in data["populations"]:
        pid = row["id"]
        if (pid.startswith("hgdp:") or pid.startswith("1kg:")) and not pid.endswith(("XX", "XY")):
            sub[pid] = (row["ac"], row["an"])
    hg = {k.split(":", 1)[1]: v for k, v in sub.items() if k.startswith("hgdp:")}
    tg = {k.split(":", 1)[1]: v for k, v in sub.items() if k.startswith("1kg:")}
    print(f"{label}: hgdp pops {len(hg)}, 1kg pops {len(tg)}; sum AC {sum(v[0] for v in sub.values())}, "
          f"sum AN {sum(v[1] for v in sub.values())}")
    merged = {}
    for k, v in list(hg.items()) + list(tg.items()):
        merged.setdefault(k.lower(), []).append(v)
    same = diff = missing = 0
    examples = []
    for p, (ac, an) in sorted(dense.items()):
        api = merged.get(p)
        if api is None:
            missing += 1
            examples.append((p, "dense", (ac, an), "api", None))
            continue
        a_ac, a_an = api[0]
        if (a_ac, a_an) == (ac, an):
            same += 1
        else:
            diff += 1
            if len(examples) < 12:
                examples.append((p, "dense", (ac, an), "api", (a_ac, a_an)))
    extra = sorted(set(merged) - set(dense))
    print(f"  identical {same}, differ {diff}, absent from api {missing}, api-only labels {extra}")
    for e in examples[:12]:
        print("   ", e)
