#!/bin/sh
# Link every plugin in this folder into the Hermes root and every profile, and enable it there.
# Re-run after creating a new profile. The desktop half still needs Capabilities → Plugins → enable (once).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
for plugin in "$HERE"/*/; do
  id="$(basename "$plugin")"
  for home in "$HOME/.hermes" "$HOME"/.hermes/profiles/*; do
    [ -d "$home" ] || continue
    mkdir -p "$home/plugins"
    [ -e "$home/plugins/$id" ] || ln -s "${plugin%/}" "$home/plugins/$id"
    profile="$(basename "$home")"
    if [ "$home" = "$HOME/.hermes" ]; then hermes plugins enable "$id"; else hermes -p "$profile" plugins enable "$id"; fi
  done
done
