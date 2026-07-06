#!/usr/bin/env sh
set -eu

container="${1:-rag-kb-app-rag-kb-app-1}"
target="${2:-./backups/app-$(date +%Y%m%d-%H%M%S).sqlite}"

mkdir -p "$(dirname "$target")"
docker cp "$container:/data/app.sqlite" "$target"
echo "Wrote $target"
