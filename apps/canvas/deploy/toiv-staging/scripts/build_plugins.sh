#!/usr/bin/env bash
# Package every plugin-packages/<id>/ into staging plugins dir (*.beeftv-plugin zip), without mutating the repo.
set -euo pipefail
SRC=/home/merlin/beeftv/plugin-packages; OUT=/home/merlin/beeftv-staging/plugins
mkdir -p $OUT; rm -f $OUT/*.beeftv-plugin
for m in $SRC/*/manifest.json; do d=${m%/manifest.json}; id=${d##*/}
  (cd $d && { find manifest.json README.md docs assets web backend LICENSE -type f 2>/dev/null || true; } | LC_ALL=C sort | zip -X -q $OUT/$id.beeftv-plugin -@)
done; ls $OUT | wc -l
