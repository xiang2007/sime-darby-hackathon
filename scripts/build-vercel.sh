#!/bin/sh
# Builds the standalone site for Vercel. web/index.html is written as an
# artifact page (no doctype or <html>), so wrap it in a full document here.
set -e
rm -rf dist
mkdir -p dist
{
  printf '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  cat web/index.html
  printf '\n</html>\n'
} > dist/index.html
# Static data the page loads, e.g. the OpenStreetMap campus snapshot (scripts/osm-campus.mjs)
if [ -d web/data ]; then cp -r web/data dist/data; fi
