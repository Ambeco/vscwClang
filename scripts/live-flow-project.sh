#!/bin/sh
# Usage: scripts/live-flow-project.sh <config.js-file-with-"const CFG = {...};"> <mode> [maxSeconds]
# Prefixes the config (and mode) to live-flow-project.js and posts it to the running live driver.
cfg="$1"; mode="$2"; max="${3:-600}"
dir=$(dirname "$0")
{ cat "$cfg"; echo "CFG.mode = '$mode';"; cat "$dir/live-flow-project.js"; } | curl -s -m "$max" --data-binary @- http://127.0.0.1:9444/run
echo
