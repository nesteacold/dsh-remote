// Opt-in file trace for the app's redacting `DebugLog` (FR-011).
//
// A normal build records nothing: `debugLogSinksFromEnv()` returns an empty list unless the build
// literally inlined `EXPO_PUBLIC_DSH_DEBUG_LOG=1`, and only then is `expo-file-system` loaded. The
// sink appends the *already redacted* `LogLine.text` the `DebugLog` produced — it never sees a
// frame, a token or a pairing code — so it cannot widen what the log exposes.
//
// Why a file: the failure this exists for (the host's `hello` was reported as delivered to JS, the
// bearer socket still died on its 10 s handshake deadline) is decided inside JS, and a release
// build's JS console is attached to nothing. Read the trace with `e2e/device/pull-debug-log.ps1`.

import type { File as ExpoFile } from 'expo-file-system';

import type { LogLine, LogSink } from '../core/debug-log';

/** The one file the trace lands in, inside the app's documents directory. */
export const DEBUG_LOG_FILE_NAME = 'dsh-companion-debug.log';

/** Rotation cap in bytes: past this the file keeps only its newer half (~128 KiB). */
const MAX_BYTES = 256 * 1024;

type FileSystemApi = typeof import('expo-file-system');

let fileSystem: FileSystemApi | null | undefined;

/**
 * `expo-file-system` resolves its native module while its module body runs, so it is imported
 * lazily: Metro still bundles this literal `require`, but a build that did not opt in never
 * evaluates it and never touches the native module.
 */
function loadFileSystem(): FileSystemApi | null {
  if (fileSystem !== undefined) return fileSystem;
  try {
    // Lazy require: an Expo native module must not be imported by Node (tests), web or a build
    // that did not opt in. eslint-disable-next-line @typescript-eslint/no-var-requires
    fileSystem = require('expo-file-system') as FileSystemApi;
  } catch {
    // No native module (tests, web, Expo Go without it): the trace is simply off.
    fileSystem = null;
  }
  return fileSystem;
}

/** `MM-DDTHH:MM:SS.mmmZ LEVEL text` — level and text come from the redacting log. */
function formatLine(line: LogLine): string {
  const at = new Date(line.at);
  const stamp = Number.isNaN(at.getTime()) ? '----------T--:--:--.---' : at.toISOString().slice(5);
  return `${stamp} ${line.level.toUpperCase()} ${line.text}\n`;
}

/**
 * Append one line and rotate by halves once the file passes `MAX_BYTES`.
 *
 * The cap is checked in bytes because a character may be several (Vietnamese copy reaches the
 * log through localized notices), so the halving repeats until the file actually fits.
 */
function appendLine(file: ExpoFile, text: string): void {
  // A missing file is created by `write` itself (same rule on Android and iOS).
  file.writeSync(text, { append: true });
  if (file.size <= MAX_BYTES) return;
  let kept = file.textSync();
  while (kept.length > 0) {
    kept = kept.slice(Math.ceil(kept.length / 2));
    file.writeSync(kept);
    if (file.size <= MAX_BYTES) return;
  }
}

/**
 * A `LogSink` that appends to `<directory>/dsh-companion-debug.log`, defaulting to the app's
 * documents directory (`Paths.document`). Returns `null` when the native module is unavailable.
 * Every I/O error is swallowed: a diagnostic sink must never break the caller or the app.
 */
export function createDebugLogFileSink(options: { directory?: string } = {}): LogSink | null {
  const api = loadFileSystem();
  if (api === null) return null;
  let target: ExpoFile;
  try {
    const directory = options.directory === undefined ? api.Paths.document : new api.Directory(options.directory);
    target = new api.File(directory, DEBUG_LOG_FILE_NAME);
  } catch {
    return null;
  }
  return (line: LogLine) => {
    try {
      appendLine(target, formatLine(line));
    } catch {
      // Full disk, a revoked directory, a closed native module: the file trace just ends here.
    }
  };
}

/**
 * The sinks the controller's `DebugLog` is constructed with: empty in every normal build, the file
 * sink only when the build set `EXPO_PUBLIC_DSH_DEBUG_LOG=1` (Expo inlines `EXPO_PUBLIC_*` at
 * build time, so this flag is a build decision, not something a released app can turn on).
 */
export function debugLogSinksFromEnv(): LogSink[] {
  if (process.env.EXPO_PUBLIC_DSH_DEBUG_LOG !== '1') return [];
  const sink = createDebugLogFileSink();
  return sink === null ? [] : [sink];
}
