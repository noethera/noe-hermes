#!/usr/bin/env bash
# Build every theme in ui/themes/ with the shared ui/bubbles.css as customCSS, and install it into Hermes
# (root and every profile, since the desktop reads the active profile's home). Reopen the Hermes app afterwards.
set -euo pipefail
UI="$(cd "$(dirname "$0")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
build() {
  cat "$1"
  printf '\ncustomCSS: |\n'
  sed 's/^/  /' "$UI/bubbles.css"
}
for theme in "$UI"/themes/*.yaml; do
  name="$(basename "$theme")"
  for dir in "$HERMES_HOME" "$HERMES_HOME"/profiles/*/; do
    [ -d "$dir" ] || continue
    mkdir -p "$dir/skins"
    build "$theme" > "$dir/skins/$name"
    chmod 644 "$dir/skins/$name"
    rm -f "$dir/skins/noethera.yaml"
  done
  echo "Installed $name into $HERMES_HOME and every profile"
done
# bubbles.css uses Open Sans from the Mac, not from the network.
compgen -G "$HOME/Library/Fonts/OpenSans*" >/dev/null || compgen -G "/Library/Fonts/OpenSans*" >/dev/null \
  || echo "Note: Open Sans is not installed; run: brew install --cask font-open-sans"
