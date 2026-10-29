#!/bin/bash
# Build zotero/reader's dev target with Bun only (no npm/Node).
# Mirrors pdfjs/build for PDFJS_CONFIG=dev, swapping `npm ci`/`npx` for bun.
set -e
SPIKES="$(cd "$(dirname "$0")" && pwd)"
cd "$SPIKES/../vendor/reader"

bun install

pushd pdfjs/pdf.js
bun install
# Bun's domain.bind() drops return values, which hangs gulp's promise/stream
# tasks; patch it in memory (never edit node_modules: Bun hard-links its cache).
bun --bun --preload "$SPIKES/shims/bun-domain-bind.cjs" node_modules/gulp/bin/gulp.js generic
popd

PDFJS_BUILD=./pdfjs/pdf.js/build/generic
BUILD_DIR=./build/dev/pdf
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/build" "$BUILD_DIR/web/images"
cp -r "$PDFJS_BUILD/LICENSE" "$BUILD_DIR/"
cp -r "$PDFJS_BUILD/build/pdf.mjs" "$PDFJS_BUILD/build/pdf.worker.mjs" "$BUILD_DIR/build/"
cp -r "$PDFJS_BUILD/web/cmaps" "$PDFJS_BUILD/web/standard_fonts" "$PDFJS_BUILD/web/iccs" "$PDFJS_BUILD/web/wasm" "$BUILD_DIR/web/"
cp -r "$PDFJS_BUILD/web/viewer.html" "$PDFJS_BUILD/web/viewer.mjs" "$BUILD_DIR/web/"
cp -r "$PDFJS_BUILD/web/images/loading-icon.gif" "$BUILD_DIR/web/images/"
cp -r pdfjs/viewer.css "$BUILD_DIR/web/"

bun --bun x webpack --config-name dev
ls build/dev
