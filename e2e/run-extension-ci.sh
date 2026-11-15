#!/usr/bin/env bash
# Download the public judge zip (no product source in this repo), add the
# local Gmail fixture host to content_scripts.matches, record a virtual
# screen, and drive branded Chrome with Nano the same way as run-ci.sh.
set -u
cd "$(dirname "$0")"
mkdir -p out
ZIP_URL="${ZIP_URL:-https://did-i-order-this.vercel.app/downloads/did-i-order-this-extension-0.1.0.zip}"

# Keep the zip out of the uploaded artifact directory. The bundle includes
# the same public Firebase web config the live site already serves.
WORKDIR="${RUNNER_TEMP:-/tmp}/dio-extension"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
if ! curl --fail --location --silent --show-error -o "$WORKDIR/extension.zip" "$ZIP_URL"; then
  echo "Failed to download the judge zip"
  exit 1
fi
echo "Downloaded judge zip ($(wc -c < "$WORKDIR/extension.zip") bytes)"
unzip -qo "$WORKDIR/extension.zip" -d "$WORKDIR/unpacked"
EXT_DIR="$(python3 - <<PY
from pathlib import Path
roots = list(Path("$WORKDIR/unpacked").rglob("manifest.json"))
if not roots:
    raise SystemExit("unzipped judge zip has no manifest.json")
print(roots[0].parent.resolve())
PY
)"
if [ -z "${EXT_DIR:-}" ] || [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "Could not find the unpacked extension manifest"
  exit 1
fi

# The production zip only matches https://mail.google.com/*. This runner
# cannot sign into Gmail, so tests add the local fixture host. The
# extension already reads allowed prefixes from the installed manifest.
python3 - <<PY
import json
from pathlib import Path
p = Path("$EXT_DIR") / "manifest.json"
m = json.loads(p.read_text())
fixture = "http://127.0.0.1:8123/*"
changed = False
for cs in m.get("content_scripts", []):
    matches = cs.setdefault("matches", [])
    if fixture not in matches:
        matches.append(fixture)
        changed = True
if not changed:
    raise SystemExit("judge zip had no content_scripts to patch")
p.write_text(json.dumps(m, indent=2) + "\n")
print("Added local fixture host to content_scripts.matches")
PY

export DISPLAY=:99
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2
ffmpeg -y -loglevel error -video_size 1280x800 -framerate 10 -f x11grab -i :99 \
  -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p out/screen.mp4 &
FF_PID=$!
SKIP_HOSTED=1 node on-device.mjs \
  "$(command -v google-chrome)" \
  "${PROFILE_DIR:-/tmp/nano-profile}" \
  ./out \
  "${SITE_URL:-https://did-i-order-this.vercel.app/app/}" \
  "$EXT_DIR" \
  "${PROBE_TIMEOUT_MIN:-15}"
CODE=$?
kill -INT "$FF_PID" 2>/dev/null; wait "$FF_PID" 2>/dev/null
kill "$XVFB_PID" 2>/dev/null
exit "$CODE"
