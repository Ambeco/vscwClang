#!/bin/sh
# Usage: scripts/live-flow-run.sh [maxSeconds]   (Run startup and Debug latency; config scripts/flow-configs/run.js)
max="${1:-1500}"
dir=$(dirname "$0")
{ cat "$dir/flow-configs/run.js"; cat "$dir/flow-configs/setuser.js"; } | curl -s -m 60 --data-binary @- http://127.0.0.1:9444/run
echo
{ cat "$dir/flow-configs/run.js"; cat "$dir/live-flow-run.js"; } | curl -s -m "$max" --data-binary @- http://127.0.0.1:9444/run
echo
