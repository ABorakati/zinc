#!/bin/bash
# Build zotero/document-worker with Bun only (no npm/Node).
# Mirrors its `npm run build`; rsync (absent in Git Bash) replaced with cp.
set -euo pipefail
cd "$(dirname "$0")/../vendor"
[ -d document-worker ] || git clone --depth 1 --recursive --shallow-submodules https://github.com/zotero/document-worker
cd document-worker

rm -rf node_modules
bun install
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
