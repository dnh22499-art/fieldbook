#!/bin/sh
# Downloads the PDF reader (pdf.js 3.11.174, Apache-2.0) into the folder given (default web/vendor/pdfjs),
# so the website reads PDF receipts without fetching anything at run time.
set -eu
DEST="${1:-web/vendor/pdfjs}"
BASE="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174"
mkdir -p "$DEST"
for f in pdf.min.js pdf.worker.min.js; do
  curl -fsSL --retry 3 "$BASE/$f" -o "$DEST/$f"
  size=$(wc -c < "$DEST/$f")
  [ "$size" -gt 50000 ] || { echo "$f looks wrong ($size bytes)"; exit 1; }
  echo "$f: $size bytes, sha256 $(sha256sum "$DEST/$f" | cut -c1-16)…"
done
