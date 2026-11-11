#!/bin/bash
# ios-build.sh - remote iOS build orchestrator (macOS, Apple Silicon only).
#
# Runs ON THE MAC. The Windows driver (Invoke-RemoteIosBuild.ps1) stages this file on the
# Mac (sha256-verified, mode 700) and executes it from that path, so the source package can
# arrive as a tar on the script's stdin:
#
#   tar -c ... | ssh mac '/bin/bash $HOME/.dsh-ios-build/ios-build.sh --run-id=... --source=worktree'
#
# Never `bash -s`: bash would parse the tar bytes as shell text. This script immediately
# reserves fd 3 for the payload and redirects its own stdin to /dev/null, so subshells,
# traps and child processes cannot steal tar bytes.
#
# The package is the CURRENT WORKING TREE by default (tracked + untracked-not-ignored files,
# uncommitted edits included); --from-head selects a committed `git archive HEAD` instead.
# This script also answers --self-test: it reads the machine only, so a misconfigured Mac is
# reported in seconds and never costs a build.
#
# Exit contract (specs/009-remote-ios-build/spec.md):
#   0 build ok (and upload ok, if requested)
#   2 preflight refusal: not macOS, toolchain missing, low disk, not idle, bad params
#   3 another build holds the lock
#   4 build failure (source, prebuild, pods, compile, export, signing)
#   5 upload failure (artifact kept)
#   6 cleanup assertion failed (disk not back to baseline, volume still mounted)
#
# The last stdout line is `RESULT {json}`; the driver parses it, the exit code stays
# authoritative. Every log line goes through redact() and `set -x` is never used, so key
# material cannot reach the log. The ASC key path is only ever handed to xcodebuild/altool.

set -Eeuo pipefail

readonly VOL_NAME='DSHIosBuild'
readonly DEFAULT_QUOTA_GB=30
readonly DEFAULT_FLOOR_GB=15
readonly DEFAULT_IDLE_SECONDS=600
readonly DEFAULT_WATCHDOG_MIN=90
readonly MAX_BASELINE_DRIFT_GB=1
readonly STAGE_ROOT="$HOME/.dsh-ios-build"
readonly LOCK_DIR="$STAGE_ROOT/lock"
readonly CONF_FILE="$HOME/.dsh-ios-build.conf"

# Secret-bearing strings are replaced as soon as they reach a log line. Patterns cover the
# key file name, PEM armour, the issuer wording and the .p8 suffix that altool/xcodebuild
# echo on failure. Deliberately over-broad: a redacted word costs nothing, a leaked one does.
readonly REDACT_SED='s#(AuthKey[A-Za-z0-9_.:-]*|BEGIN[A-Za-z ]*PRIVATE KEY|END[A-Za-z ]*PRIVATE KEY|[Ii]ssuer[A-Za-z_]*|API[_ ]?key[A-Za-z_]*|[A-Za-z0-9_.-]*\.p8)#[redacted]#g'

QUOTA_GB=$DEFAULT_QUOTA_GB
FLOOR_GB=$DEFAULT_FLOOR_GB
IDLE_SECONDS=$DEFAULT_IDLE_SECONDS
WATCHDOG_MIN=$DEFAULT_WATCHDOG_MIN
PROFILE='production'
TEAM_ID=''
COMMIT=''
RUN_ID=''
SCHEME=''
SOURCE='worktree'
DIRTY_FILES=0
ASC_KEY_ID=''
ASC_KEY_PATH=''
ASC_ISSUER_ID=''

UPLOAD=0
NO_SIGN=0
FORCE=0
SHUTDOWN=0
SLEEP=0
KEEP_PODS_CACHE=0
SELF_TEST=0
SWIFT_VERSION_OVERRIDE=''
PATCH_EXPO_JSI=0
JSI_OVERRIDE=''
CORE_OVERRIDE=''
JSI_SENDABLE_PATCH=0
PATCH_EXPO_JSI_MODE='swift5'
PATCH_EXPO_JSI_SWIFT_EXEC=''

LOCK_HELD=0
LOCK_RECLAIMED=0
VOL_CREATED=0
VOLUME_TOUCHED=0
VOLUME_LEFTOVER=0
VOL_PATH=''
CONTAINER=''
BASELINE_FREE=0
FINAL_FREE=0
PRIMARY_EXIT=0
IPA_PATH=''
EXPORT_PLIST=''
STAGE_DIR=''
WATCHDOG_PID=''
CAFF_PID=''
RESULT_EMITTED=0
XCODE_MAJOR=0
START_EPOCH=$(/bin/date -u +%s)
STARTED_AT=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)

# Self-test counters (see self_test): essentials that fail there exit 2, warnings do not.
ST_FAIL=0
ST_WARN=0

# --------------------------------------------------------------------------- logging

redact_stream() { /usr/bin/sed -E "$REDACT_SED"; }

log() { printf '%s\n' "$*" | redact_stream; }

log_err() { printf '%s\n' "$*" | redact_stream >&2; }

die() {
    local code="$1"
    shift
    log_err "ERROR: $*"
    exit "$code"
}

# run: echo the command line as a banner, then stream its output through the redactor.
# Callers must never pass key paths or issuer values to this helper (use run_signed).
run() {
    local -a cmd
    cmd=("$@")
    log "  \$ ${cmd[*]}"
    "${cmd[@]}" 2>&1 | redact_stream
    return "${PIPESTATUS[0]}"
}

# run_quiet: same, but the banner is caller-supplied so it can omit signed arguments.
run_quiet() {
    local banner="$1"
    shift
    log "  \$ $banner"
    "$@" 2>&1 | redact_stream
    return "${PIPESTATUS[0]}"
}

usage() {
    cat <<'EOF'
ios-build.sh - remote iOS build orchestrator (macOS host, driven over ssh)

Usage:
  # the driver stages this file at ~/.dsh-ios-build/ios-build.sh first (sha256-verified)
  tar -c ... | ssh mac '/bin/bash ~/.dsh-ios-build/ios-build.sh --run-id=<id> --source=worktree [options]'
  ssh mac '/bin/bash ~/.dsh-ios-build/ios-build.sh --self-test'

Options:
  --run-id=<id>          run identifier; artifacts land in ~/.dsh-ios-build/artifacts/<id>
  --commit=<sha>         commit being built (recorded in RESULT only)
  --source=<kind>        worktree | head - what the stdin package contains (default: worktree)
  --from-head            shorthand for --source=head (a committed `git archive HEAD` tree)
  --dirty-files=<n>      uncommitted files the package carries (reported only)
  --profile=<name>       preview | production | development        (default: production)
  --team-id=<10 chars>   Apple team id; required unless --no-sign
  --quota-gb=<n>         APFS volume quota in GB                   (default: 30)
  --floor-gb=<n>         refuse to start below this free space on / (default: 15)
  --idle-seconds=<n>     required input idle time                   (default: 600)
  --watchdog-min=<n>     hard kill after n minutes                  (default: 90)
  --scheme=<name>        Xcode scheme (default: derived from the generated project)
  --self-test            read-only prerequisite report; no volume, no source, no build.
                         Exit 0 when the essentials pass, 2 when they do not
  --upload               upload the .ipa to TestFlight with the ASC key on this Mac
  --no-sign              unsigned build: no signing, no export, no upload
  --force                ignore the idle check
  --shutdown             ask for shutdown instead of staying awake; the DRIVER performs it after
                         the artifact and log are on Windows (this script never powers down)
  --patch-expo-jsi       opt-in: pin expo-modules-jsi's nested build to Swift 5 (partial fix only).
  --sleep                ask for sleep instead of staying awake; also performed by the DRIVER.
                         Default is stay-awake: a sleeping remote cannot be woken by the pipeline
  --keep-pods-cache      keep a persistent CocoaPods cache and account for its size
  --help                 this text

Config: ~/.dsh-ios-build.conf (KEY=value, mode 600, never committed, never transferred).
Known keys: DSH_IOS_TEAM_ID, DSH_IOS_PROFILE, DSH_IOS_QUOTA_GB, DSH_IOS_FLOOR_GB,
DSH_IOS_IDLE_SECONDS, DSH_IOS_WATCHDOG_MIN, DSH_IOS_SCHEME, DSH_IOS_ASC_KEY_ID,
DSH_IOS_ASC_KEY_PATH, DSH_IOS_ASC_ISSUER_ID. Values are never echoed.

Exit codes: 0 ok | 2 preflight refusal | 3 lock held | 4 build failure | 5 upload failure |
            6 cleanup assertion failed (disk not back to baseline, volume left behind)
EOF
}

# --------------------------------------------------------------------------- helpers

free_gb() {
    /bin/df -g / 2>/dev/null | /usr/bin/awk 'END {print $4}'
}

idle_seconds() {
    local ns
    ns=$(/usr/sbin/ioreg -c IOHIDSystem 2>/dev/null | /usr/bin/awk '/HIDIdleTime/ {print $NF; exit}')
    case "${ns:-}" in
        '' | *[!0-9]*) printf '0' ;;
        *) printf '%s' "$((ns / 1000000000))" ;;
    esac
}

find_container() {
    local plist dev candidate i
    plist=$(/usr/bin/mktemp -t dsh-ios-build)
    if /usr/sbin/diskutil info -plist / >"$plist" 2>/dev/null; then
        candidate=$(/usr/libexec/PlistBuddy -c 'Print :APFSContainerReference' "$plist" 2>/dev/null || true)
    fi
    /bin/rm -f "$plist"
    if [ -n "${candidate:-}" ]; then
        printf '%s' "$candidate"
        return 0
    fi
    # Fallback: /dev/disk3s1s1 -> disk3 (strip trailing slice numbers until stable).
    dev=$(/sbin/mount | /usr/bin/awk '$2 == "/" {print $1; exit}')
    dev="${dev#/dev/}"
    i=0
    while [ "$i" -lt 3 ]; do
        candidate=$(printf '%s' "$dev" | /usr/bin/sed -E 's/s[0-9]+$//')
        if [ "$candidate" = "$dev" ]; then
            break
        fi
        dev="$candidate"
        i=$((i + 1))
    done
    printf '%s' "${dev:-}"
}

json_str() { printf '%s' "$1" | /usr/bin/sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g'; }

load_conf() {
    [ -f "$CONF_FILE" ] || return 0
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            '' | '#'*) continue ;;
        esac
        case "$line" in
            *=*) ;;
            *) continue ;;
        esac
        key=${line%%=*}
        val=${line#*=}
        val=${val%\"}
        val=${val#\"}
        val=${val%\'}
        val=${val#\'}
        case "$key" in
            DSH_IOS_TEAM_ID) if [ -n "$val" ]; then TEAM_ID=$val; fi ;;
            DSH_IOS_PROFILE) if [ -n "$val" ]; then PROFILE=$val; fi ;;
            DSH_IOS_QUOTA_GB) if [ -n "$val" ]; then QUOTA_GB=$val; fi ;;
            DSH_IOS_FLOOR_GB) if [ -n "$val" ]; then FLOOR_GB=$val; fi ;;
            DSH_IOS_IDLE_SECONDS) if [ -n "$val" ]; then IDLE_SECONDS=$val; fi ;;
            DSH_IOS_WATCHDOG_MIN) if [ -n "$val" ]; then WATCHDOG_MIN=$val; fi ;;
            DSH_IOS_SCHEME) if [ -n "$val" ]; then SCHEME=$val; fi ;;
            DSH_IOS_ASC_KEY_ID) ASC_KEY_ID=$val ;;
            DSH_IOS_ASC_KEY_PATH) ASC_KEY_PATH=$val ;;
            DSH_IOS_ASC_ISSUER_ID) ASC_ISSUER_ID=$val ;;
            *) : ;;
        esac
    done <"$CONF_FILE"
}

need_value() {
    if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        die 2 "option $1 needs a value"
    fi
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --run-id) need_value "$@"; RUN_ID=$2; shift 2 ;;
            --run-id=?*) RUN_ID=${1#*=}; shift ;;
            --commit) need_value "$@"; COMMIT=$2; shift 2 ;;
            --commit=?*) COMMIT=${1#*=}; shift ;;
            --source) need_value "$@"; SOURCE=$2; shift 2 ;;
            --source=?*) SOURCE=${1#*=}; shift ;;
            --dirty-files) need_value "$@"; DIRTY_FILES=$2; shift 2 ;;
            --dirty-files=?*) DIRTY_FILES=${1#*=}; shift ;;
            --from-head) SOURCE='head'; shift ;;
            --self-test) SELF_TEST=1; shift ;;
            --profile) need_value "$@"; PROFILE=$2; shift 2 ;;
            --profile=?*) PROFILE=${1#*=}; shift ;;
            --team-id) need_value "$@"; TEAM_ID=$2; shift 2 ;;
            --team-id=?*) TEAM_ID=${1#*=}; shift ;;
            --quota-gb) need_value "$@"; QUOTA_GB=$2; shift 2 ;;
            --quota-gb=?*) QUOTA_GB=${1#*=}; shift ;;
            --floor-gb) need_value "$@"; FLOOR_GB=$2; shift 2 ;;
            --floor-gb=?*) FLOOR_GB=${1#*=}; shift ;;
            --idle-seconds) need_value "$@"; IDLE_SECONDS=$2; shift 2 ;;
            --idle-seconds=?*) IDLE_SECONDS=${1#*=}; shift ;;
            --watchdog-min) need_value "$@"; WATCHDOG_MIN=$2; shift 2 ;;
            --watchdog-min=?*) WATCHDOG_MIN=${1#*=}; shift ;;
            --scheme) need_value "$@"; SCHEME=$2; shift 2 ;;
            --scheme=?*) SCHEME=${1#*=}; shift ;;
            --upload) UPLOAD=1; shift ;;
            --no-sign) NO_SIGN=1; shift ;;
            --force) FORCE=1; shift ;;
            --shutdown) SHUTDOWN=1; shift ;;
            --sleep) SLEEP=1; shift ;;
            --patch-expo-jsi) PATCH_EXPO_JSI=1; PATCH_EXPO_JSI_MODE='swift5'; shift ;;
            --jsi-override=*) JSI_OVERRIDE=${1#*=}; shift ;;
            --core-override=*) CORE_OVERRIDE=${1#*=}; shift ;;
            --jsi-sendable-patch) JSI_SENDABLE_PATCH=1; shift ;;
            --expo-jsi-swift-exec=*) PATCH_EXPO_JSI=1; PATCH_EXPO_JSI_MODE='swift-exec'; PATCH_EXPO_JSI_SWIFT_EXEC=${1#*=}; shift ;;
            --swift-version=*) SWIFT_VERSION_OVERRIDE=${1#*=}; shift ;;
            --swift-version) need_value "$@"; SWIFT_VERSION_OVERRIDE=$2; shift 2 ;;
            --keep-pods-cache) KEEP_PODS_CACHE=1; shift ;;
            --help | -h) usage; exit 0 ;;
            *) die 2 "unknown argument: $1 (try --help)" ;;
        esac
    done
}

is_uint() {
    case "${1:-}" in
        '' | *[!0-9]*) return 1 ;;
    esac
    return 0
}

validate_args() {
    case "$PROFILE" in
        preview | production | development) : ;;
        *) die 2 "bad --profile '$PROFILE' (preview|production|development)" ;;
    esac
    case "$SOURCE" in
        worktree | head) : ;;
        *) die 2 "bad --source '$SOURCE' (worktree|head)" ;;
    esac
    is_uint "$DIRTY_FILES" || die 2 "bad --dirty-files '$DIRTY_FILES' (whole number)"
    is_uint "$QUOTA_GB" || die 2 "bad --quota-gb '$QUOTA_GB' (whole GB)"
    is_uint "$FLOOR_GB" || die 2 "bad --floor-gb '$FLOOR_GB' (whole GB)"
    is_uint "$IDLE_SECONDS" || die 2 "bad --idle-seconds '$IDLE_SECONDS'"
    is_uint "$WATCHDOG_MIN" || die 2 "bad --watchdog-min '$WATCHDOG_MIN'"
    [ "$QUOTA_GB" -ge 8 ] || die 2 "--quota-gb must be >= 8 (got $QUOTA_GB)"
    [ "$QUOTA_GB" -le 200 ] || die 2 "--quota-gb must be <= 200 (got $QUOTA_GB)"
    [ "$FLOOR_GB" -ge 5 ] || die 2 "--floor-gb must be >= 5 (got $FLOOR_GB)"
    if [ "$NO_SIGN" -eq 1 ] && [ "$UPLOAD" -eq 1 ]; then
        die 2 "--upload needs a signed build; --no-sign produces an unsigned .ipa"
    fi
    if [ -z "$RUN_ID" ]; then
        RUN_ID=$(/bin/date -u +%Y%m%dT%H%M%SZ)
    fi
    case "$RUN_ID" in
        *[!A-Za-z0-9._-]*) die 2 "bad --run-id '$RUN_ID' (letters, digits, dot, dash, underscore only)" ;;
    esac
    if [ -z "$COMMIT" ]; then
        COMMIT='unknown'
    fi
}

# --------------------------------------------------------------------------- self-test

# st_item <ok|warn|fail> <label> <value>: one report line, counting only the essentials.
st_item() {
    case "$1" in
        ok) : ;;
        warn) ST_WARN=$((ST_WARN + 1)) ;;
        fail) ST_FAIL=$((ST_FAIL + 1)) ;;
    esac
    log "  [$1] $2: $3"
}

# --self-test reads the machine and nothing else: no volume, no lock, no source, no write.
# The driver runs it before every build, so a syntax error or a misconfigured Mac costs
# seconds instead of a 20-minute build that dies in `xcodebuild`.
self_test() {
    local self_path="${BASH_SOURCE[0]:-}" syn devdir xcv free_now observed

    log "self-test: $VOL_NAME prerequisites (read-only: no volume, no source, no build)"
    log "host: $(/usr/bin/uname -n) ($(/usr/bin/uname -s) $(/usr/bin/uname -m))"

    # The Mac's own bash parses this very file. The driver always stages the script to a
    # file first (FR-018), so `bash -n "$0"` is a real check; the streamed case is only a
    # fallback for someone running `bash -s` by hand, and says so instead of faking a pass.
    case "$self_path" in
        '' | 'bash' | '-' | '/dev/stdin')
            st_item warn 'bash -n (self)' 'skipped: the script arrived on stdin (manual bash -s), not from a file; the driver always stages it first' ;;
        *)
            if [ ! -r "$self_path" ]; then
                st_item warn 'bash -n (self)' "skipped: $self_path is not readable"
            elif syn=$(/bin/bash -n "$self_path" 2>&1); then
                st_item ok 'bash -n (self)' 'no syntax errors'
            else
                st_item fail 'bash -n (self)' "$(printf '%s' "$syn" | /usr/bin/tr '\n' ' ')"
            fi
            ;;
    esac

    if [ "$(/usr/bin/uname -s)" = 'Darwin' ]; then
        st_item ok 'macOS' "$(/usr/bin/sw_vers -productVersion) $(/usr/bin/uname -m)"
    else
        st_item fail 'macOS' "$(/usr/bin/uname -s) is not macOS; this script runs on the Mac only"
    fi
    case "$(/usr/bin/uname -m)" in
        arm64) st_item ok 'architecture' 'arm64 (Apple Silicon)' ;;
        *) st_item warn 'architecture' "$(/usr/bin/uname -m) - spec 009 assumes Apple Silicon" ;;
    esac

    devdir=$(/usr/bin/xcode-select -p 2>/dev/null || true)
    case "${devdir:-}" in
        */Xcode.app/Contents/Developer) st_item ok 'xcode-select' "$devdir" ;;
        '') st_item fail 'xcode-select' 'no developer dir; fix: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer' ;;
        *) st_item fail 'xcode-select' "$devdir (Command Line Tools?); fix: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" ;;
    esac

    if xcv=$(/usr/bin/xcodebuild -version 2>&1); then
        st_item ok 'xcodebuild' "$(printf '%s' "$xcv" | /usr/bin/tr '\n' ' ')"
    else
        case "$xcv" in
            *icense*) st_item fail 'xcodebuild' 'Xcode license not accepted; fix: sudo xcodebuild -license accept' ;;
            *) st_item fail 'xcodebuild' "$(printf '%s' "$xcv" | /usr/bin/tr '\n' ' ')" ;;
        esac
    fi
    if /usr/bin/xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
        st_item ok 'Xcode license/first launch' 'accepted and complete'
    else
        # Also fails without root on some installs, so this stays a warning: the license
        # state that actually blocks a build already shows up in the xcodebuild line above.
        st_item warn 'Xcode license/first launch' 'not confirmed; fix: sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch'
    fi

    if command -v pod >/dev/null 2>&1; then
        st_item ok 'cocoapods' "pod $(pod --version 2>/dev/null || printf 'unknown') at $(command -v pod)"
    else
        st_item fail 'cocoapods' "pod is not on PATH (looked in /opt/homebrew/bin, /usr/local/bin; install: brew install cocoapods)"
    fi

    # CocoaPods dies with "Unicode Normalization not appropriate for ASCII-8BIT" when Ruby
    # starts without a UTF-8 locale — which is the normal state of an ssh session. The script
    # forces one in normalise_locale(); report it so a future failure is obvious.
    case "${LC_ALL:-${LANG:-}}" in
        *UTF-8*|*utf8*|*UTF8*) st_item ok 'locale' "UTF-8 (${LC_ALL:-$LANG})" ;;
        *) st_item warn 'locale' "not UTF-8 (LANG='${LANG:-}'); normalise_locale() forces one for the build" ;;
    esac

    if /usr/bin/xcrun altool --help >/dev/null 2>&1; then
        st_item ok 'altool' 'xcrun altool available (-Upload can work)'
    else
        st_item warn 'altool' 'not available on this Xcode; -Upload would fail with exit 5 (Transporter.app is the fallback)'
    fi

    is_uint "$FLOOR_GB" || FLOOR_GB=$DEFAULT_FLOOR_GB
    free_now=$(free_gb)
    if ! is_uint "${free_now:-}"; then
        st_item fail 'free space' 'cannot read / (df -g)'
    elif [ "$free_now" -lt "$FLOOR_GB" ]; then
        st_item fail 'free space' "${free_now} GB free on / is below the ${FLOOR_GB} GB floor"
    else
        st_item ok 'free space' "${free_now} GB free on / (floor ${FLOOR_GB} GB)"
    fi

    observed=$(idle_seconds)
    if [ "$observed" -lt "$IDLE_SECONDS" ]; then
        st_item warn 'idle' "${observed}s since the last input; a run without --force would be refused (< ${IDLE_SECONDS}s)"
    else
        st_item ok 'idle' "${observed}s since the last input (${IDLE_SECONDS}s required)"
    fi

    if [ -d "$LOCK_DIR" ]; then
        if can_reclaim_lock; then
            st_item warn 'lock' "present with no live holder: $LOCK_DIR (the next run reclaims it)"
        else
            st_item warn 'lock' "a build holds it: $(/bin/cat "$LOCK_DIR/owner" 2>/dev/null | /usr/bin/tr '\n' ' ')"
        fi
    else
        st_item ok 'lock' "free ($LOCK_DIR)"
    fi

    if [ -e "/Volumes/$VOL_NAME" ]; then
        st_item warn 'stale volume' "/Volumes/$VOL_NAME exists; the next run reclaims it (the lock prevents concurrency)"
    else
        st_item ok 'stale volume' "/Volumes/$VOL_NAME absent"
    fi
    # Orphans are registered in APFS but not mounted, so they are invisible to /Volumes and df.
    # Report them here (read-only: the self-test never deletes) so a leak cannot go unnoticed.
    # `|| true` matters: grep -c exits 1 when the count is 0, and `set -e` would abort the
    # self-test right here (observed: the report stopped after "stale volume" with exit 2).
    leftover=$(/usr/sbin/diskutil apfs list 2>/dev/null | /usr/bin/grep -c "Name: *$VOL_NAME" || true)
    if [ "${leftover:-0}" -gt 0 ]; then
        st_item warn 'orphan volumes' "$leftover APFS volume(s) named $VOL_NAME still registered (not mounted); the next build reclaims them, or run: diskutil apfs deleteVolume <disk3sN>"
    else
        st_item ok 'orphan volumes' "no leftover $VOL_NAME volumes in the APFS container"
    fi

    log "self-test: nothing was changed (no volume, no lock, no transfer)"
    if [ "$ST_FAIL" -gt 0 ]; then
        log "self-test: FAIL - ${ST_FAIL} essential check(s) failed, ${ST_WARN} warning(s); fix the [fail] lines first"
        exit 2
    fi
    log "self-test: PASS - 0 essential failures, ${ST_WARN} warning(s)"
    exit 0
}

# --------------------------------------------------------------------------- lock + volume

can_reclaim_lock() {
    local pidf pid old
    pidf="$LOCK_DIR/owner"
    if [ -f "$pidf" ]; then
        pid=$(/usr/bin/awk -F= '/^pid=/ {print $2; exit}' "$pidf")
        if [ -n "${pid:-}" ] && /bin/kill -0 "$pid" 2>/dev/null; then
            # Holder is alive: only a lock older than the watchdog ceiling is a leftover.
            old=$(/usr/bin/find "$LOCK_DIR" -maxdepth 0 -mmin +"$WATCHDOG_MIN" 2>/dev/null || true)
            if [ -n "${old:-}" ]; then
                return 0
            fi
            return 1
        fi
    fi
    return 0
}

acquire_lock() {
    local holder
    /bin/mkdir -p "$STAGE_ROOT" || die 2 "cannot create $STAGE_ROOT"
    /bin/chmod 700 "$STAGE_ROOT" 2>/dev/null || true
    if /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
        {
            printf 'pid=%s\n' "$$"
            printf 'started=%s\n' "$STARTED_AT"
            printf 'run=%s\n' "$RUN_ID"
        } >"$LOCK_DIR/owner"
        LOCK_HELD=1
        log "lock: acquired $LOCK_DIR (pid $$, run $RUN_ID)"
        return 0
    fi
    holder=$(/bin/cat "$LOCK_DIR/owner" 2>/dev/null | /usr/bin/tr '\n' ' ' || true)
    if can_reclaim_lock; then
        log "WARN lock: stale lock reclaimed (holder was: ${holder:-unknown})"
        /bin/rm -rf "$LOCK_DIR"
        LOCK_RECLAIMED=1
        if /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
            {
                printf 'pid=%s\n' "$$"
                printf 'started=%s\n' "$STARTED_AT"
                printf 'run=%s\n' "$RUN_ID"
            } >"$LOCK_DIR/owner"
            LOCK_HELD=1
            log "lock: acquired after reclaim (pid $$, run $RUN_ID)"
            return 0
        fi
    fi
    log_err "ERROR: another build holds the lock: $LOCK_DIR (${holder:-owner file missing})"
    exit 3
}

release_lock() {
    if [ "$LOCK_HELD" -eq 1 ]; then
        /bin/rm -rf "$LOCK_DIR" 2>/dev/null || true
        log "lock: released"
        LOCK_HELD=0
    fi
}

prune_staging() {
    [ -d "$STAGE_ROOT/artifacts" ] || return 0
    /usr/bin/find "$STAGE_ROOT/artifacts" -mindepth 1 -maxdepth 1 -type d -mtime +3 \
        -exec /bin/rm -rf {} + 2>/dev/null || true
    log "cleanup: pruned staged runs older than 3 days under $STAGE_ROOT/artifacts"
}

create_volume() {
    local i existing orphan dev
    # From here on the volume name is ours to assert on in cleanup.
    VOLUME_TOUCHED=1
    existing=$(/bin/ls -d "/Volumes/$VOL_NAME" 2>/dev/null || true)
    if [ -n "${existing:-}" ]; then
        # An exact-name leftover can only be ours: the lock makes concurrent runs impossible.
        log "WARN volume: leftover volume found, reclaiming: $existing"
        /usr/sbin/diskutil unmount force "$existing" >/dev/null 2>&1 || true
        /usr/sbin/diskutil apfs deleteVolume "$existing" >/dev/null 2>&1 || true
        /bin/rmdir "$existing" 2>/dev/null || true
    fi
    # Orphans from earlier runs are registered but not mounted, so `ls /Volumes` misses them and
    # they keep holding space. Reclaim them by device before adding a new volume, so a machine
    # already carrying leftovers heals itself instead of accumulating (measured 2026-11-09:
    # six orphans, 16.5 GB, invisible to df).
    orphan=$(/usr/sbin/diskutil apfs list 2>/dev/null | /usr/bin/grep -c "Name: *$VOL_NAME" || true)
    if [ "${orphan:-0}" -gt 0 ]; then
        log "WARN volume: reclaiming $orphan orphaned $VOL_NAME volume(s) from earlier runs"
        reclaimed=$(reclaim_all_volumes_by_name)
        log "volume: after reclaim $reclaimed $VOL_NAME volume(s) remain"
    fi
    log "volume: diskutil apfs addVolume $CONTAINER APFS $VOL_NAME -quota ${QUOTA_GB}g"
    /usr/sbin/diskutil apfs addVolume "$CONTAINER" APFS "$VOL_NAME" -quota "${QUOTA_GB}g" >/dev/null ||
        die 4 "cannot create the APFS build volume (quota ${QUOTA_GB}g)"
    VOL_CREATED=1
    VOL_PATH="/Volumes/$VOL_NAME"
    i=0
    while [ "$i" -lt 30 ]; do
        if [ -d "$VOL_PATH" ] && [ -w "$VOL_PATH" ]; then
            break
        fi
        # addVolume normally automounts; nudge it once in case automount is disabled.
        if [ "$i" -eq 5 ]; then
            /usr/sbin/diskutil mount "$VOL_PATH" >/dev/null 2>&1 || true
        fi
        /bin/sleep 1
        i=$((i + 1))
    done
    [ -d "$VOL_PATH" ] || die 4 "build volume did not mount at $VOL_PATH"
    log "volume: mounted at $VOL_PATH"
    /bin/mkdir -p "$VOL_PATH/src" "$VOL_PATH/home/tmp" "$VOL_PATH/npm" "$VOL_PATH/dd" "$VOL_PATH/out"
}

# List the APFS device identifiers of volumes named exactly $VOL_NAME, one per line.
# `diskutil apfs list -plist` output is parsed with plutil so this does not depend on the
# human-readable layout. Falls back to name matching in the plain listing.
# Delete every APFS volume named $VOL_NAME (mounted or not) and report how many remain.
# Deleting by NAME avoids depending on the mount path (which is gone once unmounted) and on
# parsing diskutil's listing; each call removes one volume, so this loops until none is left.
reclaim_all_volumes_by_name() {
    local n=0 max=12
    while [ "$n" -lt "$max" ]; do
        if ! /usr/sbin/diskutil apfs list 2>/dev/null | /usr/bin/grep -q "Name: *$VOL_NAME"; then
            break
        fi
        if ! /usr/sbin/diskutil apfs deleteVolume "$VOL_NAME" >/dev/null 2>&1; then
            # Ambiguous name or a stubborn volume: fall back to the device id parsed from the
            # listing, then give up if that fails too.
            local dev
            dev=$(current_volume_device)
            if [ -z "${dev:-}" ]; then
                break
            fi
            log "cleanup: deleting leftover volume $dev by device"
            /usr/sbin/diskutil apfs deleteVolume "$dev" >/dev/null 2>&1 || break
        fi
        n=$((n + 1))
    done
    /usr/sbin/diskutil apfs list 2>/dev/null | /usr/bin/grep -c "Name: *$VOL_NAME" || true
}

# Device identifier (disk3sN) of the first volume named $VOL_NAME, or empty.
current_volume_device() {
    /usr/sbin/diskutil apfs list 2>/dev/null | /usr/bin/awk -v want="$VOL_NAME" '
        /APFS Volume Disk/ {
            dev = $0
            sub(/^.*\(/, "", dev)
            sub(/\).*$/, "", dev)
            match($0, /\(disk[0-9]+s[0-9]+\)/)
        }
        match($0, /\(disk[0-9]+s[0-9]+\)/) {
            d = substr($0, RSTART + 1, RLENGTH - 2)
        }
        /Name:/ {
            nm = $0
            sub(/^.*Name:[ \t]*/, "", nm)
            sub(/[ \t].*$/, "", nm)
            if (nm == want && d != "") { print d; exit }
        }
    '
}

destroy_volume() {
    local i dev left
    if [ "$VOL_CREATED" -ne 1 ]; then
        return 0
    fi
    /usr/sbin/diskutil unmount force "$VOL_PATH" >/dev/null 2>&1 || true

    # Delete BY NAME / BY DEVICE, not by mount path. `deleteVolume "$VOL_PATH"` silently fails
    # once the volume is unmounted (the path is gone), which left SIX orphaned 1-3 GB volumes
    # registered in APFS across six runs and drained the Mac from 22 GB to 9 GB free
    # (measured 2026-11-09). Every leftover here is a disk leak the owner pays for.
    /usr/sbin/diskutil apfs deleteVolume "$VOL_PATH" >/dev/null 2>&1 || true
    left=$(reclaim_all_volumes_by_name)

    if [ "${left:-0}" -gt 0 ]; then
        log_err "ERROR: cleanup left $left APFS volume(s) named $VOL_NAME behind (delete with: diskutil apfs deleteVolume $VOL_NAME)"
        VOLUME_LEFTOVER=$left
    else
        log "cleanup: volume $VOL_NAME deleted (verified: none left in the APFS container)"
    fi
    /bin/rmdir "$VOL_PATH" 2>/dev/null || true
    VOL_CREATED=0
}

# --------------------------------------------------------------------------- pipeline

preflight() {
    local uname_s devdir xcv free_now idle node_v
    uname_s=$(/usr/bin/uname -s)
    [ "$uname_s" = 'Darwin' ] || die 2 "this script runs on macOS only (uname says '$uname_s')"
    log "preflight: host $(/usr/bin/uname -n), $(/usr/bin/uname -m), macOS $(/usr/bin/sw_vers -productVersion)"

    devdir=$(/usr/bin/xcode-select -p 2>/dev/null || true)
    case "${devdir:-}" in
        */Xcode.app/Contents/Developer) log "preflight: xcode-select -> Xcode.app" ;;
        '') die 2 "xcode-select has no developer dir; fix: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" ;;
        *) die 2 "xcode-select points at '$devdir' (Command Line Tools?); fix: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" ;;
    esac

    if ! xcv=$(/usr/bin/xcodebuild -version 2>&1); then
        case "$xcv" in
            *icense*) die 2 "Xcode license not accepted; fix: sudo xcodebuild -license accept" ;;
            *) die 2 "xcodebuild -version failed: $xcv" ;;
        esac
    fi
    XCODE_MAJOR=$(printf '%s\n' "$xcv" | /usr/bin/awk 'NR==1 {print $2}' | /usr/bin/cut -d. -f1)
    is_uint "$XCODE_MAJOR" || XCODE_MAJOR=0
    log "preflight: $(printf '%s' "$xcv" | /usr/bin/tr '\n' ' ')"

    free_now=$(free_gb)
    is_uint "$free_now" || die 2 "cannot read free space on / (df -g)"
    if [ "$free_now" -lt "$FLOOR_GB" ]; then
        die 2 "low disk on /: ${free_now} GB free < floor ${FLOOR_GB} GB (nothing was changed)"
    fi
    log "preflight: free on / ${free_now} GB (floor ${FLOOR_GB} GB)"

    idle=$(idle_seconds)
    if [ "$idle" -lt "$IDLE_SECONDS" ] && [ "$FORCE" -ne 1 ]; then
        die 2 "machine not idle: last input ${idle}s ago < ${IDLE_SECONDS}s (pass --force to build anyway)"
    fi
    log "preflight: idle policy ${IDLE_SECONDS}s, observed ${idle}s, force=$FORCE -> proceed"

    command -v node >/dev/null 2>&1 || die 2 "node is not on PATH on the Mac; install Node >= 24"
    node_v=$(node --version 2>/dev/null || true)
    log "preflight: node ${node_v:-unknown}"

    CONTAINER=$(find_container)
    [ -n "${CONTAINER:-}" ] || die 2 "cannot determine the APFS container of / (diskutil info -plist /)"
    log "preflight: APFS container $CONTAINER"

    if [ "$NO_SIGN" -eq 0 ]; then
        [ -n "$TEAM_ID" ] || die 2 "no Apple team id: pass --team-id or set DSH_IOS_TEAM_ID in ~/.dsh-ios-build.conf"
        [ -n "$ASC_KEY_ID" ] || die 2 "no ASC key id: set DSH_IOS_ASC_KEY_ID in ~/.dsh-ios-build.conf (key id only, never the key)"
        [ -n "$ASC_KEY_PATH" ] || die 2 "no ASC key path: set DSH_IOS_ASC_KEY_PATH in ~/.dsh-ios-build.conf"
        [ -f "$ASC_KEY_PATH" ] || die 2 "ASC key file DSH_IOS_ASC_KEY_PATH is missing (path not printed)"
        if [ "$UPLOAD" -eq 1 ]; then
            [ -n "$ASC_ISSUER_ID" ] || die 2 "no ASC issuer: set DSH_IOS_ASC_ISSUER_ID in ~/.dsh-ios-build.conf"
        fi
    else
        log "preflight: --no-sign -> no signing identity, no export, no upload"
    fi
}

start_guards() {
    # Nothing may keep the Mac awake after the run: both helpers are killed in cleanup.
    /usr/bin/caffeinate -dimsu -w $$ >/dev/null 2>&1 &
    CAFF_PID=$!
    (
        /bin/sleep $((WATCHDOG_MIN * 60))
        /bin/kill -TERM $$ 2>/dev/null
    ) >/dev/null 2>&1 &
    WATCHDOG_PID=$!
    log "guards: caffeinate pid $CAFF_PID, watchdog ${WATCHDOG_MIN} min (pid $WATCHDOG_PID)"
}

record_baseline() {
    BASELINE_FREE=$(free_gb)
    is_uint "$BASELINE_FREE" || die 2 "cannot read the disk baseline (df -g /)"
    log "baseline: ${BASELINE_FREE} GB free on / before the build"
}

extract_source() {
    log "source: extracting the $SOURCE package from payload fd 3 into $VOL_PATH/src"
    # fd 3 is the reserved payload descriptor: never fd 0, which main() points at /dev/null.
    # `!` keeps `set -e` from aborting with tar's own status: the contract only allows 0..6.
    if ! /usr/bin/tar -x -f /dev/fd/3 -C "$VOL_PATH/src" 2>&1 | redact_stream; then
        die 4 "source extraction failed (truncated package stream?)"
    fi
    [ -d "$VOL_PATH/src/apps/mobile-companion" ] ||
        die 4 "package does not contain apps/mobile-companion (wrong commit or wrong repo?)"
    log "source: $(/usr/bin/find "$VOL_PATH/src" -type f | /usr/bin/wc -l | /usr/bin/tr -d ' ') files extracted"
}

install_deps() {
    local app_dir="$VOL_PATH/src/apps/mobile-companion"
    log "deps: npm ci (cache inside the volume)"
    (
        cd "$app_dir" || exit 1
        export CI=1
        export npm_config_cache="$VOL_PATH/npm"
        export npm_config_fund=false
        export npm_config_audit=false
        export npm_config_update_notifier=false
        run npm ci --no-audit --no-fund
    ) || die 4 "npm ci failed (see log above)"

    # PROBE ONLY (--jsi-override=<version>): replace expo-modules-jsi inside the disposable volume
    # to answer "does an older publish compile with this toolchain?". Nothing in the repo and
    # nothing on the Mac changes, and the override dies with the volume, so this is safe to run
    # without touching the product's dependency graph. `--no-save` keeps the lockfile untouched.
    if [ -n "${JSI_OVERRIDE:-}" ]; then
        log "deps: PROBE overriding expo-modules-jsi -> $JSI_OVERRIDE (volume only, repo untouched)"
        (
            cd "$app_dir" || exit 1
            export CI=1
            export npm_config_cache="$VOL_PATH/npm"
            export npm_config_fund=false
            export npm_config_audit=false
            export npm_config_update_notifier=false
            # `npm install expo-modules-jsi@ver --no-save` is NOT enough: expo-modules-core keeps
            # its own nested copy which wins at build time (measured: the failing compile came from
            # node_modules/expo-modules-core/node_modules/expo-modules-jsi, not the top-level one).
            # npm "overrides" is the only mechanism that rewrites resolution across the whole tree.
            run npm pkg set "overrides.expo-modules-jsi=$JSI_OVERRIDE"
            # expo-modules-core 58.0.30 calls JavaScriptValue.encoding, an API that only exists in
            # jsi >= 58.0.21 — and every jsi >= 58.0.21 has the Swift 6.2 data-race error. The two
            # constraints are disjoint, so core has to come down with jsi.
            if [ -n "${CORE_OVERRIDE:-}" ]; then
                run npm pkg set "overrides.expo-modules-core=$CORE_OVERRIDE"
            fi
            run npm install --no-audit --no-fund
        ) || die 4 "jsi override install failed (expo-modules-jsi@$JSI_OVERRIDE)"
        # Prove which copy the compiler will actually see, nested ones included.
        found=$(/usr/bin/find "$app_dir/node_modules" -maxdepth 4 -type d -name 'expo-modules-jsi' 2>/dev/null |
            while IFS= read -r d; do
                printf '%s=%s ' "${d#$app_dir/node_modules/}" \
                    "$(/usr/bin/sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$d/package.json" 2>/dev/null | /usr/bin/head -n 1)"
            done)
        log "deps: PROBE jsi copies: $found"
        case "$found" in
            *"=$JSI_OVERRIDE "*) : ;;
            *) log "WARN deps: PROBE override did not take effect (expected $JSI_OVERRIDE in every copy)" ;;
        esac
    fi
}

# PROBE (--jsi-sendable-patch): make JavaScriptValue.Slot Sendable so its pointer can cross the
# synchronous isolation boundary at JavaScriptObject.swift:946. This is the fix upstream would
# apply, not a safety downgrade: the struct already stores `nonisolated(unsafe) let start:
# UnsafeMutableRawPointer`, and the call site documents that the isolated closure runs
# synchronously on the same thread. Swift 6.2 simply cannot prove it for a ~Copyable type.
# Applied inside the disposable volume only; opt-in because it edits third-party concurrency code.
patch_jsi_slot_sendable() {
    local app_dir="$VOL_PATH/src/apps/mobile-companion"
    local f patched=0
    # The effective copy is usually NESTED under expo-modules-core, not the top-level one, so walk
    # the whole tree and patch every copy that exists (deep path: node_modules/expo-modules-core/
    # node_modules/expo-modules-jsi/apple/Sources/.../Runtime/Values/JavaScriptValue+Slot.swift).
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        if /usr/bin/grep -q 'Slot: ~Copyable, @unchecked Sendable' "$f"; then
            log "patch-jsi: already @unchecked Sendable: ${f#$app_dir/}"
            patched=$((patched + 1))
            continue
        fi
        if /usr/bin/grep -q 'public struct Slot: ~Copyable {' "$f"; then
            /usr/bin/sed 's/public struct Slot: ~Copyable {/public struct Slot: ~Copyable, @unchecked Sendable {/' \
                "$f" >"$f.patched" && /bin/cat "$f.patched" >"$f" && /bin/rm -f "$f.patched"
        fi
        if /usr/bin/grep -q 'Slot: ~Copyable, @unchecked Sendable' "$f"; then
            log "patch-jsi: Slot is now @unchecked Sendable: ${f#$app_dir/}"
            patched=$((patched + 1))
        else
            log "WARN patch-jsi: declaration did not match in ${f#$app_dir/}"
        fi
    done < <(/usr/bin/find "$app_dir/node_modules" -type f -name 'JavaScriptValue+Slot.swift' 2>/dev/null)
    if [ "$patched" -eq 0 ]; then
        log "WARN patch-jsi: no JavaScriptValue+Slot.swift found under node_modules"
    fi

    # The Sendable conformance is not enough: the diagnostic names `slot`, the raw pointer captured
    # by the isolated closure. Build the Slot OUTSIDE the closure and capture that instead, so the
    # pointer never crosses the isolation boundary. Same semantics: the Slot value is created on
    # this thread and used synchronously.
    local obj
    while IFS= read -r obj; do
        [ -n "$obj" ] || continue
        if /usr/bin/grep -q 'let slotValue = JavaScriptValue.Slot(slot)' "$obj"; then
            log "patch-jsi: call site already hoisted: ${obj#$app_dir/}"
            continue
        fi
        /usr/bin/awk '
            /try runtime\._withUnsafeGuaranteedRef \{ runtime in/ && !done {
                print "    let slotValue = JavaScriptValue.Slot(slot)"
                done = 1
            }
            /try encode\(JavaScriptValue\.Slot\(slot\), runtime\)/ {
                sub(/JavaScriptValue\.Slot\(slot\)/, "slotValue")
            }
            { print }
        ' "$obj" >"$obj.patched" && /bin/cat "$obj.patched" >"$obj" && /bin/rm -f "$obj.patched"
        if /usr/bin/grep -q 'let slotValue = JavaScriptValue.Slot(slot)' "$obj" && /usr/bin/grep -q 'try encode(slotValue, runtime)' "$obj"; then
            log "patch-jsi: call site hoisted out of the isolated closure: ${obj#$app_dir/}"
        else
            log "WARN patch-jsi: call site did not match; upstream changed, not patching"
        fi
    done < <(/usr/bin/find "$app_dir/node_modules" -type f -name 'JavaScriptObject.swift' 2>/dev/null)
}

# expo-modules-jsi 58.0.22 declares swift_version '6.0' and builds its xcframework from a
# Pods script phase that runs a NESTED xcodebuild under `env -i` (no inherited environment,
# no inherited build settings). Xcode 26.0.1 ships Swift 6.2, which rejects that source with
#   JavaScriptObject.swift:946: error: sending 'slot' risks causing data races
# and no command-line flag of ours can reach the nested build. The package lives inside the
# disposable build volume, so the honest fix is to pin the nested build to Swift 5 there:
# nothing on the Mac and nothing in the repo is touched, and the patch disappears with the
# volume. Re-evaluate when Expo ships a version that compiles under Swift 6.2.
patch_expo_modules_jsi() {
    local app_dir="$VOL_PATH/src/apps/mobile-companion"
    local f="$app_dir/node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh"
    # OPT-IN ONLY (--patch-expo-jsi). Measured 2026-11-09: forcing Swift 5 into the nested build
    # fixes the Swift 6.2 data-race error, but that package also relies on Swift-6-only C++
    # interop behaviour, so each next attempt fails further in:
    #   data race -> bare-slash regex -> 'exception' not found -> 'jsi/jsi.h' not found.
    # A half-broken patch is worse than an honest failure, so it stays off unless asked for.
    if [ "$PATCH_EXPO_JSI" -ne 1 ]; then
        log "patch: skipped (expo-modules-jsi Swift pin is opt-in: --patch-expo-jsi)"
        return 0
    fi
    if [ ! -f "$f" ]; then
        log "patch: expo-modules-jsi build script not found; nothing to patch"
        return 0
    fi
    if /usr/bin/grep -q 'SWIFT_VERSION=5' "$f"; then
        log "patch: expo-modules-jsi nested build already pinned to Swift 5"
        return 0
    fi
    # Insert the setting right before the existing SWIFT_COMPILATION_MODE line of the nested
    # xcodebuild invocation; bail out loudly if the anchor moved rather than corrupting it.
    # Rewritten through a temp file instead of `sed -i`: BSD sed needs `-i ''`, GNU sed does
    # not, and this way the same code works if the script is ever exercised off the Mac.
    #
    # Two settings, because Swift 5 mode alone is not enough: this package also uses bare-slash
    # regex literals (`name.wholeMatch(of: /^[a-zA-Z_$].../)`), which Swift 5 mode leaves disabled
    # and then fails with "'$' is not a valid digit in integer literal". Verified by reading
    # JavaScriptRuntime.swift:439 of expo-modules-jsi 58.0.22.
    # Two mechanisms, because they fail differently:
    #   mode swift5     : SWIFT_VERSION=5 + bare-slash regex. Fixes the 6.2 data-race error, then
    #                     runs into C++ interop gaps (the package needs Swift 6 interop).
    #   mode swift-exec : keep Swift 6 language mode and swap only the compiler via SWIFT_EXEC,
    #                     e.g. the Command Line Tools' Swift 6.1.2, whose region-isolation checks
    #                     are older. xcodebuild keeps Xcode's SDKs; only swiftc changes.
    if [ "$PATCH_EXPO_JSI_MODE" = 'swift-exec' ]; then
        if [ ! -x "$PATCH_EXPO_JSI_SWIFT_EXEC" ]; then
            log "WARN patch: --expo-jsi-swift-exec path is not executable: $PATCH_EXPO_JSI_SWIFT_EXEC"
            return 0
        fi
        /usr/bin/awk -v exe="$PATCH_EXPO_JSI_SWIFT_EXEC" '
            /^    SWIFT_COMPILATION_MODE=wholemodule/ {
                print "    SWIFT_EXEC=" exe " \\"
            }
            { print }
        ' "$f" >"$f.patched" && /bin/cat "$f.patched" >"$f" && /bin/rm -f "$f.patched"
        if /usr/bin/grep -q 'SWIFT_EXEC=' "$f"; then
            log "patch: expo-modules-jsi nested build uses SWIFT_EXEC=$PATCH_EXPO_JSI_SWIFT_EXEC"
        else
            log "WARN patch: SWIFT_EXEC insertion did not take effect"
        fi
        return 0
    fi

    if /usr/bin/grep -q '^    SWIFT_COMPILATION_MODE=wholemodule' "$f"; then
        # awk rather than sed: the inserted line contains `$(inherited)` and backslashes, which are
        # a minefield through three levels of quoting (PowerShell -> ssh -> sed). Inside a
        # single-quoted awk program they are literal, and awk inserts whole lines with no escaping.
        /usr/bin/awk '
            /^    SWIFT_COMPILATION_MODE=wholemodule/ {
                print "    SWIFT_VERSION=5 \\"
                print "    OTHER_SWIFT_FLAGS=\"$(inherited) -enable-bare-slash-regex -cxx-interoperability-mode=default\" \\"
            }
            { print }
        ' "$f" >"$f.patched" && /bin/cat "$f.patched" >"$f" && /bin/rm -f "$f.patched"
        if /usr/bin/grep -q 'SWIFT_VERSION=5' "$f" && /usr/bin/grep -q 'enable-bare-slash-regex' "$f"; then
            log "patch: expo-modules-jsi nested xcodebuild pinned to Swift 5 + bare-slash regex + C++ interop"
        else
            log "WARN patch: the awk insertion did not take effect; the archive may fail on expo-modules-jsi"
        fi
    else
        log "WARN patch: anchor 'SWIFT_COMPILATION_MODE=wholemodule' not found; upstream changed, not patching"
    fi
}

prebuild_ios() {    local app_dir="$VOL_PATH/src/apps/mobile-companion"
    log "prebuild: expo prebuild --platform ios --no-install (no EAS, no Expo login)"
    (
        cd "$app_dir" || exit 1
        export CI=1
        export EXPO_NO_TELEMETRY=1
        if [ -x ./node_modules/.bin/expo ]; then
            run ./node_modules/.bin/expo prebuild --platform ios --no-install
        else
            run npx expo prebuild --platform ios --no-install
        fi
    ) || die 4 "expo prebuild failed"
    [ -d "$app_dir/ios" ] || die 4 "expo prebuild produced no ios/ directory"
}

resolve_scheme() {
    local app_dir="$VOL_PATH/src/apps/mobile-companion" proj
    if [ -n "${SCHEME:-}" ]; then
        log "pods: scheme (from --scheme) $SCHEME"
        return 0
    fi
    proj=$(/bin/ls -d "$app_dir/ios/"*.xcodeproj 2>/dev/null | /usr/bin/head -n 1)
    [ -n "${proj:-}" ] || die 4 "cannot derive the Xcode scheme (no *.xcodeproj generated)"
    SCHEME=$(/usr/bin/basename "$proj" .xcodeproj)
    log "pods: scheme derived from the project: $SCHEME"
}

install_pods() {
    local app_dir="$VOL_PATH/src/apps/mobile-companion"
    log "pods: install"
    (
        cd "$app_dir/ios" || exit 1
        export COCOAPODS_DISABLE_STATS=1
        # The pod cache is ~1 GB per cold run (specs repo + downloaded pods) and defaults to
        # ~/Library/Caches/CocoaPods, which is OUTSIDE the volume: it survived cleanup and blew
        # the ±1 GB drift budget (observed 2026-11-09, 22 GB -> 18 GB). Keep it inside the
        # volume so deleting the volume deletes it too. --keep-pods-cache moves it to the
        # persistent stage dir instead, and the drift assertion accounts for that size.
        if [ "$KEEP_PODS_CACHE" -eq 1 ]; then
            export CP_HOME_DIR="$STAGE_ROOT/cocoapods"
            /bin/mkdir -p "$CP_HOME_DIR"
            log "pods: persistent cache at $CP_HOME_DIR (--keep-pods-cache; baseline math accounts for it)"
        else
            export CP_HOME_DIR="$VOL_PATH/pods"
            export PODS_CACHE_DIR="$VOL_PATH/pods/cache"
            /bin/mkdir -p "$CP_HOME_DIR" "$PODS_CACHE_DIR"
            log "pods: cache inside the build volume ($CP_HOME_DIR), deleted with the volume"
        fi
        # React Native downloads prebuilt core/artifacts (~96 MB each) into
        # ~/Library/Caches/ReactNative by default — also outside the volume.
        export RN_CACHE_DIR="$VOL_PATH/rncache"
        /bin/mkdir -p "$RN_CACHE_DIR"
        export XDG_CACHE_HOME="$VOL_PATH/rncache"
        if [ -f Podfile.lock ]; then
            run pod install --deployment
        else
            # A first prebuild has no Podfile.lock; --deployment requires one.
            log "pods: no Podfile.lock in the generated project -> pod install (not --deployment)"
            run pod install
        fi
    ) || die 4 "pod install failed"
}

check_signing_identity() {
    local count
    if [ "$NO_SIGN" -eq 1 ]; then
        log "signing: skipped (--no-sign)"
        return 0
    fi
    count=$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null |
        /usr/bin/awk '/^[[:space:]]*[0-9]+\)/ {c++} END {print (c + 0)}')
    if [ "${count:-0}" -eq 0 ]; then
        # FR-017: with an ASC API key, automatic signing creates the certificate, so a Mac
        # that has never signed must not be blocked here. Without the key it stays fatal.
        if [ -n "${ASC_KEY_PATH:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
            log "WARN signing: no keychain identity yet; automatic signing will try to create one (identity count: 0)"
            return 0
        fi
        die 4 "no valid code-signing identity in the keychain (identity count: 0)"
    fi
    log "signing: automatic, identity count ${count} (names never logged)"
}

archive_app() {
    local app_dir="$VOL_PATH/src/apps/mobile-companion" ws
    ws=$(/bin/ls -d "$app_dir/ios/"*.xcworkspace 2>/dev/null | /usr/bin/head -n 1)
    if [ -z "${ws:-}" ]; then
        die 4 "no .xcworkspace generated (pod install did not run?)"
    fi
    local -a xl
    xl=(archive -workspace "$ws" -scheme "$SCHEME" -configuration Release
        -destination 'generic/platform=iOS'
        -archivePath "$VOL_PATH/out/app.xcarchive"
        -derivedDataPath "$VOL_PATH/dd")
    # --swift-version=N pins the Swift language mode for every target. Needed when a third-party
    # pod does not compile under the toolchain's default (Swift 6 strict concurrency): Xcode 26 /
    # Swift 6.2 rejects expo-modules-jsi 58.0.22 with "sending 'slot' risks causing data races",
    # which is an upstream issue, not a project one.
    if [ -n "${SWIFT_VERSION_OVERRIDE:-}" ]; then
        xl+=("SWIFT_VERSION=$SWIFT_VERSION_OVERRIDE")
        log "archive: Swift language mode pinned to $SWIFT_VERSION_OVERRIDE for all targets"
    fi
    log "archive: xcodebuild archive -scheme $SCHEME -destination generic/platform=iOS (derived data in the volume)"
    if [ "$NO_SIGN" -eq 1 ]; then
        (
            cd "$app_dir/ios" || exit 1
            export TMPDIR="$VOL_PATH/home/tmp"
            # These MUST be trailing xcodebuild arguments, not `env VAR=...`: xcodebuild only
            # reads build settings from its own argument list, so an environment variable is
            # ignored and the archive keeps demanding a development team (observed 2026-11-09:
            # "Signing for DSHCompanion requires a development team" with CODE_SIGNING_ALLOWED
            # exported). Blank every signing input the generated project may carry.
            run_quiet "xcodebuild archive (unsigned: CODE_SIGNING_ALLOWED=NO)" \
                /usr/bin/xcodebuild "${xl[@]}" \
                CODE_SIGNING_ALLOWED=NO \
                CODE_SIGNING_REQUIRED=NO \
                CODE_SIGN_IDENTITY="" \
                CODE_SIGN_STYLE=Manual \
                DEVELOPMENT_TEAM="" \
                PROVISIONING_PROFILE_SPECIFIER="" \
                EXPANDED_CODE_SIGN_IDENTITY=""
        ) || die 4 "xcodebuild archive failed (unsigned)"
    else
        (
            cd "$app_dir/ios" || exit 1
            export TMPDIR="$VOL_PATH/home/tmp"
            run_quiet "xcodebuild archive (automatic signing, team set, ASC key id attached)" \
                /usr/bin/xcodebuild "${xl[@]}" \
                -allowProvisioningUpdates \
                DEVELOPMENT_TEAM="$TEAM_ID" \
                CODE_SIGN_STYLE=Automatic \
                -authenticationKeyPath "$ASC_KEY_PATH" \
                -authenticationKeyID "$ASC_KEY_ID" \
                -authenticationKeyIssuerID "$ASC_ISSUER_ID"
        ) || die 4 "xcodebuild archive failed (signing/provisioning? see log above)"
    fi
    [ -d "$VOL_PATH/out/app.xcarchive" ] || die 4 "xcodebuild reported success but no .xcarchive exists"
    log "archive: $VOL_PATH/out/app.xcarchive"
}

generate_export_options() {
    EXPORT_PLIST="$VOL_PATH/out/ExportOptions.plist"
    local method
    if [ "$XCODE_MAJOR" -ge 15 ]; then
        case "$PROFILE" in
            production) method='app-store-connect' ;;
            preview) method='release-testing' ;;
            *) method='debugging' ;;
        esac
    else
        case "$PROFILE" in
            production) method='app-store' ;;
            preview) method='ad-hoc' ;;
            *) method='development' ;;
        esac
    fi
    {
        printf '<?xml version="1.0" encoding="UTF-8"?>\n'
        printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        printf '<plist version="1.0">\n<dict>\n'
        printf '\t<key>method</key>\n\t<string>%s</string>\n' "$method"
        printf '\t<key>signingStyle</key>\n\t<string>automatic</string>\n'
        printf '\t<key>teamID</key>\n\t<string>%s</string>\n' "$TEAM_ID"
        printf '\t<key>destination</key>\n\t<string>export</string>\n'
        printf '\t<key>stripSwiftSymbols</key>\n\t<true/>\n'
        printf '\t<key>uploadSymbols</key>\n\t<true/>\n'
        printf '\t<key>compileBitcode</key>\n\t<false/>\n'
        printf '</dict>\n</plist>\n'
    } >"$EXPORT_PLIST"
    log "export: ExportOptions.plist written (method $method, no secrets inside)"
}

make_unsigned_ipa() {
    local app
    app=$(/bin/ls -d "$VOL_PATH/out/app.xcarchive/Products/Applications/"*.app 2>/dev/null | /usr/bin/head -n 1)
    [ -n "${app:-}" ] || die 4 "the archive contains no .app payload"
    /bin/mkdir -p "$VOL_PATH/out/payload/Payload"
    /bin/cp -R "$app" "$VOL_PATH/out/payload/Payload/" || die 4 "cannot stage the unsigned payload"
    /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$VOL_PATH/out/payload/Payload" "$VOL_PATH/out/app.ipa" ||
        die 4 "cannot package the unsigned .ipa"
    IPA_PATH="$VOL_PATH/out/app.ipa"
    log "export: unsigned .ipa packaged ($(/usr/bin/basename "$app"))"
}

export_ipa() {
    local app_dir="$VOL_PATH/src/apps/mobile-companion" found
    if [ "$NO_SIGN" -eq 1 ]; then
        make_unsigned_ipa
        return 0
    fi
    /bin/mkdir -p "$VOL_PATH/out/export"
    log "export: xcodebuild -exportArchive (automatic signing)"
    (
        cd "$app_dir/ios" || exit 1
        export TMPDIR="$VOL_PATH/home/tmp"
        run_quiet "xcodebuild -exportArchive (ASC key id attached)" \
            /usr/bin/xcodebuild -exportArchive \
            -archivePath "$VOL_PATH/out/app.xcarchive" \
            -exportOptionsPlist "$EXPORT_PLIST" \
            -exportPath "$VOL_PATH/out/export" \
            -allowProvisioningUpdates \
            -authenticationKeyPath "$ASC_KEY_PATH" \
            -authenticationKeyID "$ASC_KEY_ID" \
            -authenticationKeyIssuerID "$ASC_ISSUER_ID"
    ) || die 4 "xcodebuild -exportArchive failed (provisioning profile expired?)"
    found=$(/bin/ls -d "$VOL_PATH/out/export/"*.ipa 2>/dev/null | /usr/bin/head -n 1)
    [ -n "${found:-}" ] || die 4 "-exportArchive produced no .ipa"
    IPA_PATH="$VOL_PATH/out/mobile-companion.ipa"
    /bin/mv "$found" "$IPA_PATH" || die 4 "cannot move the exported .ipa"
    log "export: $IPA_PATH"
}

upload_ipa() {
    if [ "$UPLOAD" -ne 1 ]; then
        log "upload: skipped (no --upload)"
        return 0
    fi
    # No --apiIssuer value is ever echoed: the banner names the key id only.
    log "upload: xcrun altool --upload-app (key id ${ASC_KEY_ID}, issuer redacted)"
    if ! /usr/bin/xcrun altool --upload-app --type ios --file "$IPA_PATH" \
        --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | redact_stream; then
        log_err "ERROR: upload failed; the .ipa is staged and kept for retrieval (exit 5)"
        exit 5
    fi
    log "upload: TestFlight accepted the build"
}

# stage_artifacts must run before cleanup destroys the volume AND before the upload: the .ipa
# leaves the volume into $STAGE_ROOT, where the Windows driver scp's it from. It also runs
# before upload_ipa (FR-016) so an upload failure still leaves a retrievable artifact. The
# driver then deletes this run's directory in one ssh call as soon as the transfer succeeded,
# so staging does not grow by ~300 MB per run. The 3-day prune in cleanup() is only the
# safety net for a run whose driver died before it could clean up (the .ipa must outlive the
# transfer). From here on IPA_PATH/EXPORT_PLIST point at the staged copies, which is what
# RESULT reports and what the driver scp's.
stage_artifacts() {
    STAGE_DIR="$STAGE_ROOT/artifacts/$RUN_ID"
    /bin/mkdir -p "$STAGE_DIR" || die 4 "cannot create the staging directory"
    /bin/cp "$IPA_PATH" "$STAGE_DIR/app.ipa" || die 4 "cannot stage the .ipa"
    if [ -f "$EXPORT_PLIST" ]; then
        /bin/cp "$EXPORT_PLIST" "$STAGE_DIR/ExportOptions.plist" || true
    fi
    /bin/chmod 644 "$STAGE_DIR"/* 2>/dev/null || true
    IPA_PATH="$STAGE_DIR/app.ipa"
    if [ -f "$STAGE_DIR/ExportOptions.plist" ]; then
        EXPORT_PLIST="$STAGE_DIR/ExportOptions.plist"
    fi
    log "artifacts: staged in $STAGE_DIR"
}

# --------------------------------------------------------------------------- cleanup

cleanup() {
    local rc=$?
    trap - EXIT INT TERM HUP
    set +e
    if [ "$rc" -ge 128 ]; then
        # Killed by a signal (watchdog / dropped tunnel): report it as a build failure.
        rc=4
    fi
    if [ "$PRIMARY_EXIT" -eq 0 ] && [ "$rc" -ne 0 ]; then
        PRIMARY_EXIT=$rc
    fi

    if [ -n "${WATCHDOG_PID:-}" ]; then
        /bin/kill "$WATCHDOG_PID" 2>/dev/null
    fi
    if [ -n "${CAFF_PID:-}" ]; then
        /bin/kill "$CAFF_PID" 2>/dev/null
        log "guards: caffeinate stopped"
    fi

    destroy_volume
    release_lock

    local drift_allow=$MAX_BASELINE_DRIFT_GB cleanup_failed=0 cache_kb=0
    if [ "$KEEP_PODS_CACHE" -eq 1 ] && [ -d "$STAGE_ROOT/cocoapods" ]; then
        cache_kb=$(/usr/bin/du -sk "$STAGE_ROOT/cocoapods" 2>/dev/null | /usr/bin/awk '{print $1}')
        is_uint "${cache_kb:-}" || cache_kb=0
        drift_allow=$((drift_allow + (cache_kb + 1048575) / 1048576))
        log "cleanup: --keep-pods-cache accounts for $((cache_kb / 1024)) MB of persistent cache"
    fi

    if [ "$VOLUME_TOUCHED" -eq 1 ] && [ -e "/Volumes/$VOL_NAME" ]; then
        log_err "ERROR: cleanup assertion failed: /Volumes/$VOL_NAME still exists"
        cleanup_failed=1
    fi
    # A registered-but-unmounted volume is invisible to /Volumes and to df, yet it still holds
    # real space. Treat it as a hard cleanup failure: this is how six volumes silently ate 16 GB.
    if [ "${VOLUME_LEFTOVER:-0}" -gt 0 ]; then
        log_err "ERROR: cleanup assertion failed: $VOLUME_LEFTOVER APFS volume(s) named $VOL_NAME are still registered"
        cleanup_failed=1
    fi
    if [ "$BASELINE_FREE" -gt 0 ]; then
        FINAL_FREE=$(free_gb)
        is_uint "$FINAL_FREE" || FINAL_FREE=0
        if [ "$((BASELINE_FREE - FINAL_FREE))" -gt "$drift_allow" ]; then
            # APFS can return a deleted volume's blocks lazily, so an immediate reading
            # overstates the leak. Settle for up to a minute before calling it a failure.
            local tries=0
            while [ "$tries" -lt 6 ]; do
                log "cleanup: drift $((BASELINE_FREE - FINAL_FREE)) GB over budget, waiting 10s for APFS to settle ($((tries + 1))/6)"
                /bin/sleep 10
                FINAL_FREE=$(free_gb)
                is_uint "$FINAL_FREE" || FINAL_FREE=0
                if [ "$((BASELINE_FREE - FINAL_FREE))" -le "$drift_allow" ]; then
                    break
                fi
                tries=$((tries + 1))
            done
        fi
        if [ "$((BASELINE_FREE - FINAL_FREE))" -gt "$drift_allow" ]; then
            log_err "ERROR: cleanup assertion failed: free space ${BASELINE_FREE} GB -> ${FINAL_FREE} GB (drift budget ${drift_allow} GB)"
            # Name the usual suspects so the failure is actionable instead of a mystery.
            log_err "       largest caches outside the volume:"
            for d in "$HOME/Library/Caches/CocoaPods" "$HOME/Library/Caches/ReactNative" "$HOME/.npm" "$HOME/Library/Developer/Xcode/DerivedData"; do
                [ -d "$d" ] || continue
                log_err "       $(/usr/bin/du -sh "$d" 2>/dev/null)"
            done
            cleanup_failed=1
        else
            log "cleanup: free space ${BASELINE_FREE} GB -> ${FINAL_FREE} GB (within ${drift_allow} GB)"
        fi
    fi
    if [ "$cleanup_failed" -eq 1 ]; then
        # A disk leak outranks a build failure: the owner's constraint is the disk.
        rc=6
        if [ "$PRIMARY_EXIT" -eq 0 ]; then
            PRIMARY_EXIT=6
        fi
    fi

    prune_staging

    emit_result "$rc"
    # Power-down is DRIVER-OWNED (FR-016): the driver still has to scp the artifact and
    # delete the stage directory after this process exits, so the remote script never
    # sleeps or shuts the Mac down. RESULT carries the requested action instead.
    exit "$rc"
}

emit_result() {
    local rc="$1" status
    if [ "$RESULT_EMITTED" -eq 1 ]; then
        return 0
    fi
    RESULT_EMITTED=1
    case "$rc" in
        0) status='ok' ;;
        2) status='preflight-refused' ;;
        3) status='locked' ;;
        4) status='build-failed' ;;
        5) status='upload-failed' ;;
        6) status='cleanup-failed' ;;
        *) status='error' ;;
    esac
    local signing='automatic'
    if [ "$NO_SIGN" -eq 1 ]; then
        signing='none'
    fi
    local dur=$(( $(/bin/date -u +%s) - START_EPOCH ))
    local power='stay-awake'
    if [ "$SHUTDOWN" -eq 1 ]; then
        power='shutdown'
    elif [ "$SLEEP" -eq 1 ]; then
        power='sleep'
    fi
    printf 'RESULT {"runId":"%s","exit":%d,"primaryExit":%d,"status":"%s","commit":"%s","source":"%s","dirtyFiles":%d,"profile":"%s","signing":"%s","uploaded":%s,"teamId":"%s","bundleId":"com.dshext.companion","quotaGb":%d,"floorGb":%d,"baselineFreeGb":%d,"finalFreeGb":%d,"volumeDeleted":%s,"lockReclaimed":%s,"durationSec":%d,"ipa":"%s","exportOptions":"%s","stageDir":"%s","power":"%s","startedAt":"%s"}\n' \
        "$(json_str "$RUN_ID")" "$rc" "$PRIMARY_EXIT" "$status" \
        "$(json_str "$COMMIT")" "$(json_str "$SOURCE")" "$DIRTY_FILES" "$(json_str "$PROFILE")" "$signing" \
        "$([ "$UPLOAD" -eq 1 ] && printf 'true' || printf 'false')" \
        "$(json_str "$TEAM_ID")" "$QUOTA_GB" "$FLOOR_GB" \
        "$BASELINE_FREE" "$FINAL_FREE" \
        "$([ "$VOL_CREATED" -eq 0 ] && printf 'true' || printf 'false')" \
        "$([ "$LOCK_RECLAIMED" -eq 1 ] && printf 'true' || printf 'false')" \
        "$dur" "$(json_str "$IPA_PATH")" "$(json_str "$EXPORT_PLIST")" "$(json_str "$STAGE_DIR")" \
        "$power" "$STARTED_AT"
}

# Power-down lives in the driver on purpose (FR-016): it runs only after the driver has the
# .ipa on Windows and has deleted this run's stage directory. Nothing here may bring the Mac
# down while an artifact is still waiting to be fetched.

# --------------------------------------------------------------------------- main

# ssh runs a NON-login, non-interactive shell, which never reads ~/.zprofile or ~/.zshrc, so
# PATH is just /usr/bin:/bin:/usr/sbin:/sbin. Homebrew lives in /opt/homebrew/bin on Apple
# Silicon (that is where node, npm and pod are), so the toolchain is invisible unless the
# script fixes PATH itself. Doing it here keeps the pipeline independent of the owner's
# dotfiles, and keeps the behaviour identical over ssh and in a terminal.
normalise_path() {
    local dir
    for dir in /opt/homebrew/bin /opt/homebrew/sbin /usr/local/bin /usr/local/sbin "$HOME/.local/bin"; do
        case ":$PATH:" in
            *":$dir:"*) ;;
            *) [ -d "$dir" ] && PATH="$PATH:$dir" ;;
        esac
    done
    # User-installed gems (gem install --user-install) keep pod in a versioned dir.
    for dir in "$HOME"/.gem/ruby/*/bin; do
        [ -d "$dir" ] || continue
        case ":$PATH:" in
            *":$dir:"*) ;;
            *) PATH="$PATH:$dir" ;;
        esac
    done
    export PATH
}

# Over ssh the locale is usually unset, so Ruby treats its strings as ASCII-8BIT and CocoaPods
# dies with "Unicode Normalization not appropriate for ASCII-8BIT" before it even reads the
# Podfile. This is a locale problem, not a CocoaPods/Ruby version problem: force a UTF-8
# locale for every child process when the session has none.
normalise_locale() {
    local want
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
        *UTF-8*|*utf8*|*UTF8*|*utf-8*) return 0 ;;
    esac
    for want in en_US.UTF-8 C.UTF-8; do
        if /usr/bin/locale -a 2>/dev/null | /usr/bin/grep -qx "$want"; then
            export LANG="$want" LC_ALL="$want"
            return 0
        fi
    done
    export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
}

main() {
    normalise_path
    normalise_locale
    load_conf
    parse_args "$@"

    # FR-018: the source package arrives as a tar on stdin. Reserve fd 3 for it and point
    # stdin at /dev/null before anything else runs, so no subshell, trap or child process
    # can consume payload bytes. extract_source() is the only reader, and it uses /dev/fd/3.
    exec 3<&0
    exec </dev/null

    # --self-test is read-only and exits on its own; it must never take the lock, create the
    # volume or wait on the source stream.
    if [ "$SELF_TEST" -eq 1 ]; then
        self_test
    fi

    validate_args
    trap cleanup EXIT INT TERM HUP

    # State the source honestly: the owner must be able to tell a worktree build from a
    # committed one just by reading the log.
    if [ "$SOURCE" = 'head' ]; then
        log "run: $RUN_ID, commit $COMMIT, source: HEAD $COMMIT, profile $PROFILE, sanity start $STARTED_AT"
    else
        log "run: $RUN_ID, commit $COMMIT, source: worktree (HEAD $COMMIT + $DIRTY_FILES dirty files), profile $PROFILE, sanity start $STARTED_AT"
    fi
    acquire_lock
    preflight
    start_guards
    record_baseline

    create_volume
    extract_source
    install_deps
    if [ "$JSI_SENDABLE_PATCH" -eq 1 ]; then patch_jsi_slot_sendable; fi
    patch_expo_modules_jsi
    prebuild_ios
    resolve_scheme
    install_pods
    check_signing_identity
    archive_app
    generate_export_options
    export_ipa
    # FR-016: stage before the upload attempt, so an upload failure (exit 5) still leaves a
    # retrievable .ipa outside the volume that cleanup is about to delete.
    stage_artifacts
    upload_ipa

    log "done: build ok"
    exit 0
}

main "$@"
