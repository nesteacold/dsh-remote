// Debug log (FR-011): every line goes through the redaction helpers, so tokens, pairing
// codes, Authorization headers, pins and tool arguments cannot leak into the UI, the console
// or a support export. Pure: the sink is injected.

import { redactDiagnostic, redactString } from './redact';

export interface LogLine {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  text: string;
}

export type LogSink = (line: LogLine) => void;

const MAX_LINES = 200;

export class DebugLog {
  private readonly lines: LogLine[] = [];
  private readonly now: () => number;
  private readonly sinks: LogSink[];
  private enabled: boolean;

  constructor(options: { now?: () => number; sinks?: LogSink[]; enabled?: boolean } = {}) {
    this.now = options.now ?? Date.now;
    this.sinks = options.sinks ?? [];
    this.enabled = options.enabled ?? true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Log a message with an optional payload (payload keys follow redact.ts rules). */
  log(level: LogLine['level'], message: string, payload?: unknown): void {
    if (!this.enabled) return;
    const text = payload === undefined ? redactString(message) : redactDiagnostic(message, payload);
    const line: LogLine = { at: this.now(), level, text };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.shift();
    for (const sink of this.sinks) {
      try {
        sink(line);
      } catch {
        // a sink must never break the caller
      }
    }
  }

  debug(message: string, payload?: unknown): void {
    this.log('debug', message, payload);
  }

  info(message: string, payload?: unknown): void {
    this.log('info', message, payload);
  }

  warn(message: string, payload?: unknown): void {
    this.log('warn', message, payload);
  }

  error(message: string, payload?: unknown): void {
    this.log('error', message, payload);
  }

  /** Redacted lines for the diagnostics screen. */
  snapshot(): LogLine[] {
    return this.lines.map((line) => ({ ...line }));
  }
}
