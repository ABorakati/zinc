#!/usr/bin/env bash
# macOS / Linux counterpart of portable.ps1: build zotero-next and deploy it as a portable copy.
#   app/portable.sh             build (stable) + deploy
#   app/portable.sh --no-build  deploy the last build
#   app/portable.sh --no-links  unpack only (tests)
# Each deploy unpacks into its own folder, $ZN_DEPLOY_ROOT/versions/<yyyyMMdd-HHmmss>/ (default ~/ZoteroNext), and repoints
# the launcher entry at it, so the running app is never overwritten: close and reopen it to get the new version.
# Old versions are removed once nothing runs from them (the newest two are kept).
set -euo pipefail
app="$(cd "$(dirname "$0")" && pwd)"
root="${ZN_DEPLOY_ROOT:-$HOME/ZoteroNext}"
build=1 links=1
for a in "$@"; do
	case "$a" in
		--no-build) build=0 ;;
		--no-links) links=0 ;;
		*) echo "unknown argument: $a" >&2; exit 2 ;;
	esac
done

if [ "$build" = 1 ]; then (cd "$app" && hutch electrobun build --env=stable); fi

# 1. unpack into a new version folder (the build folder is named stable-<os>-<arch>)
shopt -s nullglob
archives=("$app"/build/stable-*/*.tar.zst)
if [ "${#archives[@]}" -ne 1 ]; then echo "expected one build archive under $app/build/stable-*, found ${#archives[@]}" >&2; exit 1; fi
version="$(date +%Y%m%d-%H%M%S)"
dest="$root/versions/$version"
mkdir -p "$dest"
tar --zstd -xf "${archives[0]}" -C "$dest"
echo "deployed $version -> $dest"

# 2. launcher entry
if [ "$links" = 1 ]; then
	case "$(uname -s)" in
		Darwin)
			apps=("$dest"/*.app)
			if [ "${#apps[@]}" -ne 1 ]; then echo "no .app found in $dest" >&2; exit 1; fi
			mkdir -p "$HOME/Applications"
			ln -sfn "${apps[0]}" "$HOME/Applications/Zotero Next.app"
			echo "link -> $HOME/Applications/Zotero Next.app"
			;;
		Linux)
			exe="$dest/zotero-next/bin/launcher"
			if [ ! -x "$exe" ]; then echo "launcher missing after unpacking: $exe" >&2; exit 1; fi
			entry="${XDG_DATA_HOME:-$HOME/.local/share}/applications/zotero-next.desktop"
			mkdir -p "$(dirname "$entry")"
			cat > "$entry" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Zotero Next
Exec="$exe"
Icon=$dest/zotero-next/Resources/app/views/app-icon.png
Categories=Office;Education;
DESKTOP
			echo "launcher entry -> $entry"
			;;
		*) echo "this script is for macOS and Linux; on Windows use portable.ps1" >&2; exit 1 ;;
	esac
fi

# 3. remove old versions nothing is running from (keep the newest two)
ls -1 "$root/versions" | sort -r | tail -n +3 | while read -r old; do
	dir="$root/versions/$old"
	if pgrep -f "$dir/" >/dev/null 2>&1; then echo "kept (running): $old"; else rm -rf "$dir"; echo "removed old $old"; fi
done
