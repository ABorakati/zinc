#!/bin/bash
# Build note-host/dist: Zotero note-editor `web` target (Bun only) + host page.
# Usage: bash note-host/build.sh [--skip-editor]   (skip-editor reuses vendor/note-editor/build/web)
set -e
HOST="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOST/.." && pwd)"
ED="$ROOT/vendor/note-editor"

if [ "$1" != "--skip-editor" ]; then
  [ -d "$ED/.git" ] || git clone --depth 1 --recursive https://github.com/zotero/note-editor "$ED"
  cd "$ED"
  bun install
  # prosemirror-math ships no dist under Bun (its `prepare` vite build is not run): pre-bundle it.
  mkdir -p .deps
  bun build node_modules/@benrbray/prosemirror-math/lib/main.ts --outfile .deps/prosemirror-math.js \
    --format esm --target browser --external katex --external 'prosemirror-*'
  cp "$HOST/wrapper.webpack.config.js" webpack.bun.config.js
  bun --bun x webpack --node-env production --config webpack.bun.config.js --config-name web
fi

[ -f "$ED/build/web/editor.js" ] || { echo "note-editor web build missing"; exit 1; }

cd "$HOST"
rm -rf dist; mkdir -p dist
cp -r "$ED/build/web/." dist/
find dist -name '*.map' -delete
cp src/index.html dist/index.html      # editor.html (iframe target) stays as built
bun build src/host.js --outfile dist/host.js --minify --target browser
du -sh dist
