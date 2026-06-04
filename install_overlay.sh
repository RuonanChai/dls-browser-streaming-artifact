#!/usr/bin/env bash
# Copy overlay/ onto a Spark 2.0 checkout root.
set -euo pipefail
SPARK_ROOT="${1:-}"
if [[ -z "$SPARK_ROOT" || ! -d "$SPARK_ROOT" ]]; then
  echo "Usage: bash install_overlay.sh /path/to/spark-repo-root"
  exit 1
fi
ARTIFACT_ROOT="$(cd "$(dirname "$0")" && pwd)"
OVERLAY="$ARTIFACT_ROOT/overlay"

cp -r "$OVERLAY/scripts/ready_single_user" "$SPARK_ROOT/scripts/"
cp -r "$OVERLAY/scripts/proactive_single_user_v2" "$SPARK_ROOT/scripts/"
cp -r "$OVERLAY/scripts/lib/." "$SPARK_ROOT/scripts/lib/"
mkdir -p "$SPARK_ROOT/vrc-paper/experiments"
cp "$OVERLAY/vrc-paper/experiments/"*.mjs "$SPARK_ROOT/vrc-paper/experiments/"
mkdir -p "$SPARK_ROOT/config/ready_single_user"
cp "$OVERLAY/config/experiment_matrix.json" "$SPARK_ROOT/config/ready_single_user/"
cp "$OVERLAY/src/SplatPager.ts" "$SPARK_ROOT/src/SplatPager.ts"
cp "$OVERLAY/src/SparkRenderer.ts" "$SPARK_ROOT/src/SparkRenderer.ts"

echo "Overlay installed into: $SPARK_ROOT"
echo "Next: cd $SPARK_ROOT && npm install && npm run build"
