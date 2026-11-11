#!/bin/bash
# bootstrap-mac.sh - idempotent one-time prerequisite check for the remote iOS build host.
#
# Read-only by default: it changes NOTHING. It never runs sudo, never installs anything and
# never edits sshd, the firewall or Tailscale. Every privileged step is printed as the exact
# command for the owner to run in person.
#
#   bash bootstrap-mac.sh                 # check and report (safe to run any number of times)
#   bash bootstrap-mac.sh --apply-guards  # additionally write ~/.dsh-ios-build.conf (mode 600)
#   bash bootstrap-mac.sh --help
#
# Exit: 0 all checks pass (warnings allowed) | 2 a required prerequisite is missing.
# Runbook: apps/mobile-companion/docs/remote-ios-build.md

set -Eeuo pipefail

CONF="$HOME/.dsh-ios-build.conf"
APPLY_GUARDS=0

PASSES=0
WARNS=0
FAILS=0

say() { printf '%s\n' "$*"; }
pass() { PASSES=$((PASSES + 1)); say "[ ok ] $*"; }
warn() { WARNS=$((WARNS + 1)); say "[warn] $*"; }
miss() { FAILS=$((FAILS + 1)); say "[fail] $*"; }
hint() { say "       $*"; }

on_signal() {
    say "bootstrap: interrupted; nothing was changed"
    exit 4
}
trap on_signal INT TERM HUP

usage() {
    cat <<'EOF'
bootstrap-mac.sh - one-time prerequisite check for the remote iOS build host

Usage:
  bash bootstrap-mac.sh                 check only (default; changes nothing)
  bash bootstrap-mac.sh --apply-guards  also write ~/.dsh-ios-build.conf (mode 600,
                                        non-secret defaults; an existing file is kept)
  bash bootstrap-mac.sh --help

This script never runs sudo and never installs anything: privileged steps are printed as
the exact command to run. Exit 0 = ready (warnings allowed), exit 2 = prerequisite missing.
EOF
}

apply_guards() {
    local host user
    if [ -f "$CONF" ]; then
        /bin/chmod 600 "$CONF" 2>/dev/null || true
        pass "$CONF already exists; kept untouched (mode forced to 600)"
        return 0
    fi
    host=$(/usr/sbin/scutil --get ComputerName 2>/dev/null || /usr/bin/uname -n)
    user=$(/usr/bin/id -un)
    # umask + explicit chmod: the file must never be group/world readable, even briefly.
    (
        umask 077
        cat <<EOF
# ~/.dsh-ios-build.conf - Mac-side defaults for scripts/remote-ios-build/mac/ios-build.sh
# Mode 600. Never committed, never transferred to Windows, never read by the driver.
# NON-SECRET DEFAULTS ONLY: this template has no key material and no issuer value.
# The ASC key id below is an identifier (not a secret); the key file itself stays in the
# directory App Store Connect uses, and the issuer is added by hand on this Mac only.

DSH_IOS_HOST=$host
DSH_IOS_USER=$user
DSH_IOS_TEAM_ID=
DSH_IOS_PROFILE=production
DSH_IOS_QUOTA_GB=30
DSH_IOS_FLOOR_GB=15
DSH_IOS_IDLE_SECONDS=600
DSH_IOS_WATCHDOG_MIN=90
DSH_IOS_SCHEME=
DSH_IOS_ASC_KEY_ID=
DSH_IOS_ASC_KEY_PATH=
# DSH_IOS_ASC_ISSUER_ID=    <- fill in by hand on this Mac; never commit, never send
EOF
    )
    /bin/chmod 600 "$CONF"
    pass "wrote $CONF (mode 600, non-secret defaults only)"
    hint "now fill in DSH_IOS_TEAM_ID, DSH_IOS_ASC_KEY_ID and DSH_IOS_ASC_KEY_PATH by hand"
}

check_os() {
    if [ "$(/usr/bin/uname -s)" != 'Darwin' ]; then
        miss "this bootstrap target is macOS ('$(/usr/bin/uname -s)' found)"
        return 0
    fi
    pass "macOS $(/usr/bin/sw_vers -productVersion) on $(/usr/bin/uname -m)"
}

check_tailscale() {
    local bin out ip
    bin=$(command -v tailscale 2>/dev/null || true)
    if [ -z "${bin:-}" ] && [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
        bin="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    fi
    if [ -z "${bin:-}" ]; then
        miss "Tailscale CLI not found"
        hint "install Tailscale.app, then link the CLI:"
        hint "  sudo ln -s /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale"
        return 0
    fi
    pass "Tailscale CLI: $bin"
    out=$("$bin" status 2>&1 || true)
    case "$out" in
        *'Logged out'* | *'not logged in'*)
            miss "Tailscale is logged out"
            hint "open Tailscale.app and sign in to the tailnet"
            return 0
            ;;
        '' | *'failed'*)
            warn "tailscale status returned no peer list"
            hint "check: $bin status"
            return 0
            ;;
    esac
    ip=$(printf '%s\n' "$out" | /usr/bin/awk '/^100\./ {print $1; exit}')
    if [ -n "${ip:-}" ]; then
        pass "tailnet up; this Mac is $ip (use it for ListenAddress below)"
    else
        warn "tailscale status shows no 100.x address for this Mac"
        hint "check: $bin ip -4"
    fi
}

check_remote_login() {
    local out
    if out=$(/usr/bin/sudo -n /usr/sbin/systemsetup -getremotelogin 2>/dev/null); then
        case "$out" in
            *On*) pass "Remote Login (sshd) is on" ;;
            *Off*) miss "Remote Login (sshd) is off"
                   hint "run: sudo systemsetup -setremotelogin on" ;;
            *) warn "Remote Login state unreadable: $out" ;;
        esac
        return 0
    fi
    # systemsetup is root-only; without NOPASSWD we print the command instead of asking.
    warn "cannot read Remote Login state without sudo (expected)"
    hint "run on the Mac, in person: sudo systemsetup -setremotelogin on"
    hint "then verify: sudo systemsetup -getremotelogin"
}

check_xcode() {
    local devdir xcv
    devdir=$(/usr/bin/xcode-select -p 2>/dev/null || true)
    case "${devdir:-}" in
        */Xcode.app/Contents/Developer) pass "xcode-select -> $devdir" ;;
        '') miss "xcode-select has no developer directory"
            hint "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" ;;
        *) miss "xcode-select points at '$devdir' (Command Line Tools, not Xcode)"
           hint "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" ;;
    esac

    xcv=$(/usr/bin/xcodebuild -version 2>&1 || true)
    case "$xcv" in
        Xcode*) pass "xcodebuild: $(printf '%s' "$xcv" | /usr/bin/tr '\n' ' ')" ;;
        *icense*) miss "Xcode license not accepted"
                  hint "sudo xcodebuild -license accept" ;;
        *) miss "xcodebuild -version failed: $xcv" ;;
    esac

    if /usr/bin/xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
        pass "Xcode first-launch tasks complete"
    else
        warn "Xcode first-launch tasks pending (or the check needs root)"
        hint "sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch"
    fi
}

check_cocoapods() {
    if command -v pod >/dev/null 2>&1; then
        pass "CocoaPods $(pod --version 2>/dev/null || printf 'unknown')"
        return 0
    fi
    miss "CocoaPods (pod) is not on PATH"
    hint "install one of: sudo gem install cocoapods | brew install cocoapods"
    hint "no global install: cd apps/mobile-companion && npx pod-install"
    hint "or with a Gemfile: bundle exec pod install"
}

check_altool() {
    if /usr/bin/xcrun altool --help >/dev/null 2>&1; then
        pass "xcrun altool available (TestFlight upload path)"
        return 0
    fi
    warn "xcrun altool is not available on this Xcode"
    hint "upload fallback: Transporter.app, or use a Mac with altool"
    hint "the pipeline reports exit 5 and keeps the .ipa locally; nothing is uploaded silently"
}

check_node() {
    if command -v node >/dev/null 2>&1; then
        pass "node $(node --version 2>/dev/null || printf 'unknown') / npm $(npm --version 2>/dev/null || printf 'unknown')"
        return 0
    fi
    miss "node is not on PATH"
    hint "install Node >= 24 (apps/mobile-companion engines.node)"
}

check_disk() {
    local free
    free=$(/bin/df -g / 2>/dev/null | /usr/bin/awk 'END {print $4}')
    case "${free:-}" in
        '' | *[!0-9]*) warn "cannot read free space on /"; return 0 ;;
    esac
    if [ "$free" -ge 50 ]; then
        pass "free space on /: ${free} GB (owner target > 50 GB)"
    else
        warn "free space on /: ${free} GB (< 50 GB target)"
        hint "run the baseline cleanup block below, then re-run this check"
    fi
}

check_conf() {
    local mode
    if [ ! -f "$CONF" ]; then
        warn "$CONF is missing (Mac-side defaults and ASC key id/path)"
        hint "run: bash bootstrap-mac.sh --apply-guards   (mode-600 template, no secrets)"
        return 0
    fi
    mode=$(/usr/bin/stat -f '%Lp' "$CONF" 2>/dev/null || true)
    case "${mode:-}" in
        600) pass "$CONF present, mode 600" ;;
        '') warn "cannot read the mode of $CONF"
            hint "chmod 600 $CONF" ;;
        *) warn "$CONF mode is ${mode} (should be 600)"
           hint "chmod 600 $CONF" ;;
    esac
}

show_host_keys() {
    cat <<'EOF'

--- ssh host key fingerprints (compare these BEFORE accepting the key on Windows) ----------
  The driver refuses an unknown host (StrictHostKeyChecking=yes). On the first run only,
  pass -AcceptHostKey once; before you do, compare the SHA256 line(s) below with what your
  Windows ssh prints. Tailscale authenticates the tunnel, not this key: a node whose
  tailnet key was stolen, or a re-imaged Mac, still needs this check.
EOF
    local pub seen=0 out
    for pub in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_rsa_key.pub \
        /etc/ssh/ssh_host_ecdsa_key.pub; do
        if [ ! -f "$pub" ]; then
            continue
        fi
        if out=$(/usr/bin/ssh-keygen -lf "$pub" 2>/dev/null); then
            say "  $out"
            seen=1
        fi
    done
    if [ "$seen" -eq 0 ]; then
        warn "no readable sshd host public key (ed25519/rsa/ecdsa) in /etc/ssh"
        hint "run with sudo: sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
    fi
    say "  expected on Windows: ssh-keygen -F <mac-host> -l   (or: ssh-keyscan <mac-host>)"
}

show_ssh_guidance() {
    cat <<'EOF'

--- sshd + Tailscale ACL (one-time; printed, NOT executed) -------------------------------
  # Key-only login, listener pinned to the Tailscale address printed above.
  sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak-$(date +%Y%m%d)
  sudo sh -c 'cat >> /etc/ssh/sshd_config <<HARDEN
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
ListenAddress <100.x.y.z>
HARDEN'
  sudo sshd -t                      # validate before restarting
  sudo launchctl kickstart -k system/com.openssh.sshd

  # Tailscale admin console -> Access controls: only the owner's Windows node may reach tcp:22.
  #   { "action": "accept", "src": ["autogroup:member"], "dst": [] }   # or tighter still:
  #   { "action": "accept", "src": ["<windows-node>"], "dst": ["<mac-node>:22"] }
  # Keep "ssh" in the tailnet ACL out of the picture: the Mac's own sshd is what serves 22.
EOF
}

show_baseline_cleanup() {
    cat <<'EOF'

--- baseline cleanup on the Mac (owner runs by hand; NOT executed here) --------------------
  xcrun simctl delete unavailable
  rm -rf ~/Library/Developer/Xcode/iOS\ DeviceSupport/*
  rm -rf ~/Library/Developer/Xcode/Archives/*
  rm -rf ~/Library/Developer/Xcode/DerivedData/*
  pod cache clean --all
  tmutil thinlocalsnapshots / 10000000000 1
  df -g /
EOF
}

summary() {
    say ""
    say "bootstrap: ${PASSES} ok, ${WARNS} warn, ${FAILS} fail"
    if [ "$FAILS" -gt 0 ]; then
        say "bootstrap: not ready - fix the [fail] lines above and re-run (idempotent)"
        exit 2
    fi
    say "bootstrap: ready for scripts/remote-ios-build/mac/ios-build.sh"
}

main() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --apply-guards) APPLY_GUARDS=1; shift ;;
            --help | -h) usage; exit 0 ;;
            *) say "unknown argument: $1 (try --help)"; exit 2 ;;
        esac
    done

    say "bootstrap-mac.sh - remote iOS build prerequisites (read-only unless --apply-guards)"
    say ""
    check_os
    check_tailscale
    check_remote_login
    check_xcode
    check_cocoapods
    check_altool
    check_node
    check_disk
    check_conf
    if [ "$APPLY_GUARDS" -eq 1 ]; then
        apply_guards
    fi
    show_host_keys
    show_ssh_guidance
    show_baseline_cleanup
    summary
}

main "$@"
