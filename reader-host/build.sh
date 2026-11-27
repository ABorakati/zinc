#!/bin/bash
# Build reader-host/dist: Zotero reader `web` target (Bun only) + document worker + host page.
# Usage: bash reader-host/build.sh [--skip-reader | --fetch-only]
#   --skip-reader reuses vendor/reader/build/web
#   --fetch-only  fetches vendor/reader and builds nothing (the layout analysis reads vendor/reader/structured-document-text)
set -e
# The commit of zotero/reader that is built (its submodules follow it). Change it deliberately: the workflows' cache keys are hashes
# of this file, so a new commit here also means a fresh build there.
READER_COMMIT=293d7e115fd538b35dd41ffb1dc77bb9a6ff0d39
HOST="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOST/.." && pwd)"
READER="$ROOT/vendor/reader"
SHIM="$ROOT/scripts/shims/bun-domain-bind.cjs"

fetch_reader() {
  mkdir -p "$ROOT/vendor"
  if [ ! -d "$READER/.git" ]; then
    git init -q "$READER"
    git -C "$READER" remote add origin https://github.com/zotero/reader
  fi
  if [ "$(git -C "$READER" rev-parse HEAD 2>/dev/null || true)" != "$READER_COMMIT" ]; then
    git -C "$READER" fetch -q --depth 1 origin "$READER_COMMIT"
    git -C "$READER" checkout -q --detach FETCH_HEAD
  fi
  # full submodule clones: pdf.js counts its git history for its build number (gulpfile.mjs)
  git -C "$READER" submodule update --init --recursive
}

if [ "$1" = "--fetch-only" ]; then
  fetch_reader
  exit 0
fi

if [ "$1" != "--skip-reader" ]; then
  fetch_reader
  cd "$READER"
  bun install
  pushd pdfjs/pdf.js >/dev/null
  bun install
  # Bun's domain.bind() drops return values; the preload shim fixes gulp.
  [ -d build/generic-legacy ] || bun --bun --preload "$SHIM" node_modules/gulp/bin/gulp.js generic-legacy
  [ -d build/minified-legacy ] || bun --bun --preload "$SHIM" node_modules/gulp/bin/gulp.js minified-legacy
  popd >/dev/null

  # Replicates pdfjs/build for PDFJS_CONFIG=web (npx terser -> bun --bun x terser)
  L=./pdfjs/pdf.js/build/generic-legacy
  M=./pdfjs/pdf.js/build/minified-legacy
  B=./build/web/pdf
  rm -rf "$B"; mkdir -p "$B/build" "$B/web/images"
  cp "$L/LICENSE" "$B/"
  cp "$M/build/pdf.min.mjs" "$B/build/pdf.mjs"
  cp "$M/build/pdf.worker.min.mjs" "$B/build/pdf.worker.mjs"
  cp -r "$L/web/cmaps" "$L/web/standard_fonts" "$L/web/iccs" "$L/web/wasm" "$B/web/"
  cp "$L/web/viewer.html" "$B/web/"
  bun --bun x terser "$L/web/viewer.mjs" -o "$B/web/viewer.mjs"
  cp "$L/web/images/loading-icon.gif" "$B/web/images/"
  cp pdfjs/viewer.css "$B/web/"

  bun --bun x webpack --config-name web || echo "webpack reported errors (check output exists)"
fi

[ -f "$READER/build/web/reader.js" ] || { echo "reader web build missing"; exit 1; }
[ -f "$ROOT/vendor/document-worker/build/worker.js" ] || { echo "document-worker not built: bash scripts/build-docworker.sh"; exit 1; }

cd "$HOST"
rm -rf dist; mkdir -p dist
cp -r "$READER/build/web/." dist/
rm -f dist/reader.html          # replaced by our host page
cp -r "$ROOT/vendor/document-worker/build" dist/document-worker
cp src/index.html dist/index.html
bun build src/host.js --outfile dist/host.js --minify --target browser
du -sh dist
