#!/usr/bin/env bash
# Regenerates src/fonts/*.woff2 from the google-fonts package in the dev shell.
#
# The output is COMMITTED and this almost never needs to run — only if the
# character set changes (an umlaut in the owner's note, say) or the upstream
# fonts are updated. Keeping the woff2 in git is what lets the Pages workflow
# build without a font toolchain, and guarantees visitors get byte-identical
# fonts no matter who last ran the build.
#
# Usage:  nix develop -c ./tools/fonts.sh
set -euo pipefail

cd "$(dirname "$0")/.."
out=src/fonts
mkdir -p "$out"

# The Google "latin" subset, plus the handful of marks that make German and
# French place names render correctly — the seller is Swiss and the buyer may
# not be, so Ü and é must not fall back to a system face mid-word.
latin='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

# Resolve the google-fonts store path the dev shell put on XDG_DATA_DIRS.
src_dir=""
IFS=: read -ra dirs <<<"${XDG_DATA_DIRS:-}"
for d in "${dirs[@]}" /run/current-system/sw/share; do
  if [ -d "$d/fonts/truetype" ] && [ -f "$d/fonts/truetype/InstrumentSerif-Regular.ttf" ]; then
    src_dir="$d/fonts/truetype"
    break
  fi
done

if [ -z "$src_dir" ]; then
  echo "could not find google-fonts in XDG_DATA_DIRS — run this inside 'nix develop'" >&2
  exit 1
fi

echo "fonts from: $src_dir"

# Inter ships with two variable axes. The optical-size axis is pinned rather
# than carried: nothing on this page changes opsz, and its deltas are pure
# weight in the gvar table. The weight axis IS used (400 body, 500 table
# values, 600 eyebrows), so it stays — but clamped to that range, since a
# variable font trimmed to the weights in use beats shipping two static cuts.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

fonttools varLib.instancer \
  "$src_dir/Inter[opsz,wght].ttf" \
  opsz=16 wght=400:600 \
  --output="$tmp/inter-inst.ttf"

pyftsubset "$tmp/inter-inst.ttf" \
  --unicodes="$latin" \
  --layout-features='kern,liga,calt,tnum,case' \
  --flavor=woff2 \
  --output-file="$out/inter-latin.woff2"

pyftsubset "$src_dir/InstrumentSerif-Regular.ttf" \
  --unicodes="$latin" \
  --layout-features='kern,liga,calt' \
  --flavor=woff2 \
  --output-file="$out/instrument-serif-latin.woff2"

ls -l "$out"
