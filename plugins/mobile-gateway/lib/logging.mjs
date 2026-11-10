import { appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactLine } from './redact.mjs'

export const LOG_FILE = path.join(os.tmpdir(), 'mobile-gateway.log')

// Every line is redacted once, here, before it reaches stdout or the file
// (FR-012): bearer tokens / Authorization headers, pairing codes, device
// tokens, `arguments`/`argsPreview` payloads and credential query parameters.
export function log(line) {
  const message = `[${new Date().toISOString()}] ${redactLine(line)}`
  console.log('mobile-gateway:', message)
  try {
    appendFileSync(LOG_FILE, message + '\n')
  } catch (error) {
    // 文件日志失败不能中断网关，stderr 仍保留诊断信息。
    console.error(`mobile-gateway: cannot write log file ${LOG_FILE}: ${error?.message || String(error)}`)
  }
}
