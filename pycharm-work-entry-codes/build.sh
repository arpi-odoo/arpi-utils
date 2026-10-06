#!/bin/bash
# Compiles the plugin against the locally installed PyCharm (no Gradle, no download)
# and optionally installs it: ./build.sh install
set -euo pipefail

IDE="${IDE:-$HOME/.local/share/JetBrains/Toolbox/apps/pycharm}"
PLUGINS_DIR="${PLUGINS_DIR:-$HOME/.local/share/JetBrains/PyCharm2025.3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"
JAR="$OUT/odoo-work-entry-codes.jar"

rm -rf "$OUT" && mkdir -p "$OUT/classes"
"$IDE/jbr/bin/javac" --release 21 -nowarn -d "$OUT/classes" \
    -cp "$IDE/lib/*" \
    $(find "$HERE/src" -name '*.java')
cp -r "$HERE/resources/." "$OUT/classes/"
(cd "$OUT/classes" && zip -qr "$JAR" .)
echo "Built $JAR"

if [[ "${1:-}" == "install" ]]; then
    cp "$JAR" "$PLUGINS_DIR/"
    echo "Installed into $PLUGINS_DIR — restart PyCharm"
fi
