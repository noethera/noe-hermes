# noe-hermes

Noethera's Hermes setup for a new device. Currently: the Noethera (Claude-style) desktop theme.

## Install the theme

Install Hermes and run `hermes setup` once, then:

```bash
curl -fsSL https://raw.githubusercontent.com/noethera/noe-hermes/main/install.sh | bash
```

Quit and reopen the Hermes desktop app (Cmd+Q). Run it again after creating a new profile.

Options (pass after `bash -s --`):

```bash
curl -fsSL https://raw.githubusercontent.com/noethera/noe-hermes/main/install.sh | bash -s -- --no-font
```

- `--skin default`: Nous palette instead of the warm Mono (bubbles still apply)
- `--no-font`: skip installing Open Sans
- `--no-desktop`: skip the glass sidebar setting

It writes the skins into `~/.hermes` and every profile (old files that differ go to `skins/.backup/`), sets
`display.skin`, installs Open Sans if missing, and sets the sidebar translucency. Revert with
`hermes config set display.skin default`.

## Updating

`install.sh` is generated; do not edit it here. The source lives in `noethera-agents/ui/` (`bubbles.css`,
`themes/`). After a theme change run `noethera-agents/ui/build-portable.sh`, copy `ui/dist/noethera-theme-setup.sh`
to `install.sh` in this repo, commit, and push.
