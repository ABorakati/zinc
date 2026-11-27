#!/bin/bash
# Build zotero/document-worker with Bun only (no npm/Node).
# Mirrors its `npm run build`; rsync (absent in Git Bash) replaced with cp.
set -euo pipefail
# The commit of zotero/document-worker that is built (its submodules follow it). Change it deliberately: the workflows' cache key is a
# hash of this file, so a new commit here also means a fresh build there.
DOCWORKER_COMMIT=f3f0ae36e1c28f8ad6c5aa9277281734d8c79efb
mkdir -p "$(dirname "$0")/../vendor"
cd "$(dirname "$0")/../vendor"
if [ ! -d document-worker/.git ]; then
  git init -q document-worker
  git -C document-worker remote add origin https://github.com/zotero/document-worker
fi
cd document-worker
if [ "$(git rev-parse HEAD 2>/dev/null || true)" != "$DOCWORKER_COMMIT" ]; then
  git fetch -q --depth 1 origin "$DOCWORKER_COMMIT"
  git checkout -q --detach FETCH_HEAD
fi
git submodule update --init --recursive --depth 1

rm -rf node_modules
# Upstream pins its packages in package-lock.json, which bun reads and keeps; a bun.lock, if it ever has one, is then enforced.
if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install; fi
bun --bun x webpack --mode production

rm -rf build/wasm build/onnx build/block-seg build/table-grid build/cmaps build/standard_fonts
cp -r pdf.js/external/bcmaps build/cmaps
cp -r pdf.js/external/standard_fonts build/standard_fonts
mkdir -p build/wasm build/onnx build/block-seg/clusterer build/block-seg/classifier
cp pdf.js/external/openjpeg/openjpeg.wasm pdf.js/external/jbig2/jbig2.wasm build/wasm/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm build/onnx/
model=src/pdf/structure/model/block-seg
cp $model/clusterer/model.onnx $model/clusterer/repair.onnx $model/clusterer/runtime.bin build/block-seg/clusterer/
cp $model/classifier/model.onnx $model/classifier/stats.bin build/block-seg/classifier/

bun scripts/build-metadata.js
bun scripts/build-structured-document-text.js
ls build
