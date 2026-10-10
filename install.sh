#!/bin/bash
# Installs or updates SKAZ from the latest GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/all0b0y/SKAZ/main/install.sh | bash
#
# It downloads the release's DMG and SHA256SUMS.txt, checks the checksum and that SKAZ.app is
# signed with SKAZ's own certificate, copies SKAZ.app into /Applications and opens it. A running
# SKAZ is asked to quit first; your sessions, notes and settings stay where they are. SKAZ is not
# notarized by Apple (that needs a paid Apple developer account), so a copy downloaded by a
# browser makes macOS show "Apple could not verify…" on the first launch. Files downloaded by curl
# carry no "downloaded from the internet" mark, so after this script there is no such window.
# The script is short so that you can read it before running it.
#
# For testing: SKAZ_VERSION=0.2.0, SKAZ_BASE_URL=<folder with the DMG and SHA256SUMS.txt>,
# SKAZ_INSTALL_DIR=<folder instead of /Applications>, SKAZ_NO_OPEN=1.
set -euo pipefail

REPO="all0b0y/SKAZ"
BUNDLE_ID="com.all0b0y.skaz"
CERT_SHA1="9aaf0dac082309848f22aebfdbc43efcba45b13e"   # the «SKAZ» code-signing certificate

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31mSKAZ: %s\033[0m\n' "$*" >&2; exit 1; }

main() {
  [ "$(uname -s)" = Darwin ] || die "SKAZ runs on macOS only."
  [ "$(uname -m)" = arm64 ] || die "SKAZ needs a Mac with Apple silicon."
  local os; os=$(sw_vers -productVersion)
  [ "${os%%.*}" -ge 13 ] || die "SKAZ needs macOS 13 or later; this Mac has macOS ${os}."

  local tag
  if [ -n "${SKAZ_VERSION:-}" ]; then
    tag="v${SKAZ_VERSION#v}"
  else
    tag=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
      || die "could not reach github.com/$REPO."
    tag=${tag##*/}
  fi
  case $tag in v[0-9]*) ;; *) die "no release found at github.com/$REPO/releases." ;; esac
  local version=${tag#v}
  local base=${SKAZ_BASE_URL:-https://github.com/$REPO/releases/download/$tag}
  local dest=${SKAZ_INSTALL_DIR:-/Applications}
  if [ ! -w "$dest" ]; then dest="$HOME/Applications"; mkdir -p "$dest"; fi

  tmp=$(mktemp -d -t skaz-install)
  trap 'hdiutil detach "$tmp/mnt" -quiet >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

  bold "Downloading SKAZ ${version}…"
  local name="SKAZ-${version}-arm64.dmg"
  local dmg="$tmp/$name"
  curl -fL --progress-bar -o "$dmg" "$base/$name" || die "download failed: $base/$name"
  curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || die "download failed: $base/SHA256SUMS.txt"
  local expected actual
  expected=$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS.txt")
  actual=$(shasum -a 256 "$dmg" | awk '{ print $1 }')
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || die "the checksum does not match SHA256SUMS.txt; not installing."

  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$tmp/mnt" "$dmg" </dev/null >/dev/null \
    || die "could not open the DMG."
  codesign --verify --deep --strict -R="certificate leaf = H\"$CERT_SHA1\"" "$tmp/mnt/SKAZ.app" 2>/dev/null \
    || die "SKAZ.app is not signed with SKAZ's certificate; not installing."

  # Only the copy being replaced is asked to quit, never a SKAZ running from somewhere else.
  # SKAZ may ask to confirm when a recording is unfinished, so it is never killed.
  local running="$dest/SKAZ.app/Contents/MacOS/SKAZ"
  if pgrep -f "$running" >/dev/null; then
    bold "Asking the running SKAZ to quit…"
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" </dev/null >/dev/null 2>&1 || true
    local i; for i in $(seq 1 60); do pgrep -f "$running" >/dev/null || break; sleep 0.5; done
    ! pgrep -f "$running" >/dev/null \
      || die "SKAZ is still open. Stop any recording, quit SKAZ and run this command again."
  fi

  bold "Installing into ${dest}…"
  rm -rf "$dest/.SKAZ.app.new"
  ditto "$tmp/mnt/SKAZ.app" "$dest/.SKAZ.app.new"
  rm -rf "$dest/SKAZ.app"
  mv "$dest/.SKAZ.app.new" "$dest/SKAZ.app"
  [ -n "${SKAZ_NO_OPEN:-}" ] || open "$dest/SKAZ.app"

  bold "SKAZ ${version} is installed: ${dest}/SKAZ.app"
  echo "Next, choose a speech provider in Settings → Transcription: Local Whisper keeps audio on this Mac;"
  echo "Soniox and OpenAI need an API key and cloud consent in Settings → API keys."
}

main "$@"
