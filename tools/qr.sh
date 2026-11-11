#!/usr/bin/env bash
# QR code for the printed flyer. Writes print/qr-aty-ch.svg (vector, for
# placing in the layout) and a 1200px PNG for anything that will not take SVG.
#
# Usage:  nix develop -c ./tools/qr.sh
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p print

url="https://aty.ch"

# -l H: highest error correction. The payload is 14 characters, so even at H
# this stays a low-module-count symbol that scans from a distance — and the
# redundancy is what keeps it working after a flyer has been rained on,
# thumbtacked through a corner, or printed on a tired hostel printer.
#
# -m 2: quiet zone. A QR code with no margin against a dark background is the
# single most common reason a code refuses to scan.
qrencode -t SVG -o print/qr-aty-ch.svg -l H -m 2 -s 10 "$url"
qrencode -t PNG -o print/qr-aty-ch.png -l H -m 2 -s 20 "$url"

echo "→ print/qr-aty-ch.svg  (place this in the flyer)"
echo "→ print/qr-aty-ch.png"
echo
echo "Encodes: $url"
echo "Print it at 2 cm or wider and test-scan the PRINTED copy, not the screen."
