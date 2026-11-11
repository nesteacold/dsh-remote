// Structural guards for `modules/pinned-ws/ios/PinnedWsValidity.swift` (the pinned leaf's DER).
//
// The findings these tests answer:
//
//   1. The validity parser stopped after `Validity` and returned a window without consuming the
//      mandatory `subject` / `subjectPublicKeyInfo` or the rest of the `TBSCertificate`. A
//      truncated TBS (or one with an unknown, duplicated, reordered or trailing tail) could
//      therefore still be classified as a valid window. The Swift parser now consumes the whole
//      TBS, and this file makes that behaviour checkable on a machine without Xcode.
//   2. Each `Extension` entry only had its OID read. A certificate could carry an OID-only entry,
//      a non-DER `critical`, a missing `extnValue`, a duplicated `extnID` or trailing bytes and
//      still parse. The entry is now consumed field-by-field (`extnID`, optional canonical
//      `critical`, required `extnValue`, end-of-entry); the payload stays opaque — this is DER
//      shape, never a claim about extension semantics.
//
// WHAT IS EXECUTABLE HERE, AND WHAT IS NOT:
//
//   * NO native compile. This machine has no Xcode / swiftc (the app has no generated `ios/`
//     project either), so nothing in this file proves that the Swift compiles or that
//     `SecCertificateCopyData`/`SecCertificate` behave as assumed. That still needs an Xcode or
//     device build. `pinned-ws-native.test.ts` remains the static guard for the surrounding
//     native module.
//   * The behavioural tests below run a TypeScript MIRROR of `PinnedWsValidity` (`validityWindow`
//     + `parseTime` + the bounded `DERRange` reader + the structural helpers), translated from
//     the Swift line for line. The fixtures are DER bytes built in this process (plus one real
//     `selfsigned` certificate, the same generator the mobile gateway uses), so the cases are
//     reproducible and reviewable. The mirror is not the Swift runtime: it can only prove that
//     the *logic* being described rejects these shapes. The static guards in the last describe
//     block keep the Swift source on the same structure — if the Swift is rewritten, they fail
//     and force this mirror (and the fixture expectations) to be re-derived in review.
//   * Neither kind of check is a cryptographic validator. The outer DER is already parsed by
//     `SecCertificate`, the pin authenticates the exact bytes, and the parser only decides
//     whether the TBS is structurally sane enough to read a strict validity window from it.

import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import selfsigned from 'selfsigned';

import { generateTestCertificate } from './support/certs';

const APP_ROOT = path.resolve(__dirname, '..');
const SWIFT_VALIDITY = path.join(APP_ROOT, 'modules', 'pinned-ws', 'ios', 'PinnedWsValidity.swift');
const PODSPEC = path.join(APP_ROOT, 'modules', 'pinned-ws', 'ios', 'PinnedWs.podspec');

// ---------------------------------------------------------------------------------------------
// Executable mirror of `PinnedWsValidity` (Swift). Keep in lock-step with the Swift source.
// ---------------------------------------------------------------------------------------------

const MAX_CERTIFICATE_BYTES = 1 << 20;

type PinnedWsValidityResult = 'valid' | 'expired' | 'notYetValid' | 'malformed';

interface DERContent {
  start: number;
  end: number;
}

interface Window {
  notBefore: number;
  notAfter: number;
}

interface Evaluation {
  result: PinnedWsValidityResult;
  window: Window | null;
}

/** One definite-length TLV reader. Mirrors `PinnedWsValidity.DERRange`. */
class DERReader {
  private position: number;

  constructor(
    private readonly bytes: readonly number[],
    start: number,
    readonly end: number,
  ) {
    this.position = start;
  }

  get isAtEnd(): boolean {
    return this.position === this.end;
  }

  peekTag(): number | null {
    return this.position < this.end ? this.bytes[this.position]! : null;
  }

  read(expectedTag?: number): DERContent | null {
    const bytes = this.bytes;
    if (this.position >= this.end) return null;
    const tag = bytes[this.position]!;
    if (expectedTag !== undefined && tag !== expectedTag) return null;
    if (this.position + 1 >= this.end) return null;

    const firstLength = bytes[this.position + 1]!;
    let contentLength: number;
    let headerLength: number;
    if (firstLength < 0x80) {
      contentLength = firstLength;
      headerLength = 2;
    } else {
      const count = firstLength & 0x7f;
      if (count < 1 || count > 4 || this.position + 2 + count > this.end) return null;
      // DER requires the shortest possible long-form encoding.
      if (bytes[this.position + 2]! === 0) return null;
      let value = 0;
      for (let offset = 0; offset < count; offset += 1) {
        value = value * 0x100 + bytes[this.position + 2 + offset]!;
      }
      if (value < 128) return null;
      contentLength = value;
      headerLength = 2 + count;
    }

    const contentStart = this.position + headerLength;
    if (contentStart > this.end || contentLength > this.end - contentStart) return null;
    this.position = contentStart + contentLength;
    return { start: contentStart, end: this.position };
  }
}

function singleByteInteger(content: DERContent, bytes: readonly number[]): number | null {
  if (content.end - content.start !== 1) return null;
  return bytes[content.start]!;
}

function isAlgorithmIdentifier(content: DERContent, bytes: readonly number[]): boolean {
  const algorithm = new DERReader(bytes, content.start, content.end);
  const oid = algorithm.read(0x06);
  if (oid === null || oid.end === oid.start) return false;
  if (!algorithm.isAtEnd) {
    if (algorithm.read() === null || !algorithm.isAtEnd) return false;
  }
  return true;
}

function isName(content: DERContent, bytes: readonly number[]): boolean {
  const name = new DERReader(bytes, content.start, content.end);
  while (!name.isAtEnd) {
    if (name.read(0x31) === null) return false;
  }
  return true;
}

function isSubjectPublicKeyInfo(content: DERContent, bytes: readonly number[]): boolean {
  const subjectPublicKeyInfo = new DERReader(bytes, content.start, content.end);
  const algorithmContent = subjectPublicKeyInfo.read(0x30);
  if (algorithmContent === null || !isAlgorithmIdentifier(algorithmContent, bytes)) return false;
  const subjectPublicKey = subjectPublicKeyInfo.read(0x03);
  if (subjectPublicKey === null || !isValidBitStringContent(subjectPublicKey, bytes)) return false;
  return subjectPublicKeyInfo.isAtEnd;
}

function isValidBitStringContent(content: DERContent, bytes: readonly number[]): boolean {
  if (content.end === content.start) return false;
  return bytes[content.start]! <= 7;
}

/**
 * `Extensions ::= SEQUENCE SIZE (1..MAX) OF Extension`; each
 * `Extension ::= SEQUENCE { extnID OBJECT IDENTIFIER, critical BOOLEAN DEFAULT FALSE,
 * extnValue OCTET STRING }` is consumed whole. DER forbids encoding the DEFAULT, so a present
 * `critical` must be the canonical `01 01 FF`; the extnValue is opaque (shape only, no
 * extension semantics). A repeated extnID is refused (RFC 5280 §4.2).
 */
function isExtensions(content: DERContent, bytes: readonly number[]): boolean {
  const wrapper = new DERReader(bytes, content.start, content.end);
  const extensionsContent = wrapper.read(0x30);
  if (extensionsContent === null || !wrapper.isAtEnd) return false;
  const extensions = new DERReader(bytes, extensionsContent.start, extensionsContent.end);
  if (extensions.isAtEnd) return false;
  const seenExtensionIds: DERContent[] = [];
  while (!extensions.isAtEnd) {
    const extensionContent = extensions.read(0x30);
    if (extensionContent === null) return false;
    const extensionFields = new DERReader(bytes, extensionContent.start, extensionContent.end);
    const extnID = extensionFields.read(0x06);
    if (extnID === null || extnID.end === extnID.start) return false;
    if (seenExtensionIds.some((previous) => sameBytes(previous, extnID, bytes))) return false;
    seenExtensionIds.push(extnID);
    if (extensionFields.peekTag() === 0x01) {
      const critical = extensionFields.read(0x01);
      if (critical === null || critical.end - critical.start !== 1 || bytes[critical.start] !== 0xff) {
        return false;
      }
    }
    if (extensionFields.read(0x04) === null) return false;
    if (!extensionFields.isAtEnd) return false;
  }
  return true;
}

/** Raw-content equality of two OID contents (no OID decoding). */
function sameBytes(a: DERContent, b: DERContent, bytes: readonly number[]): boolean {
  if (a.end - a.start !== b.end - b.start) return false;
  for (let offset = 0; offset < a.end - a.start; offset += 1) {
    if (bytes[a.start + offset] !== bytes[b.start + offset]) return false;
  }
  return true;
}

function number(bytes: readonly number[], start: number, count: number): number | null {
  if (start < 0 || count <= 0 || start + count > bytes.length) return null;
  let value = 0;
  for (let index = start; index < start + count; index += 1) {
    const byte = bytes[index]!;
    if (byte < 0x30 || byte > 0x39) return null;
    value = value * 10 + (byte - 0x30);
  }
  return value;
}

function makeDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (
    year < 1950 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const instant = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundtrip = new Date(instant);
  if (
    roundtrip.getUTCFullYear() !== year ||
    roundtrip.getUTCMonth() + 1 !== month ||
    roundtrip.getUTCDate() !== day ||
    roundtrip.getUTCHours() !== hour ||
    roundtrip.getUTCMinutes() !== minute ||
    roundtrip.getUTCSeconds() !== second
  ) {
    return null;
  }
  return instant;
}

function parseTime(tag: number, content: DERContent, bytes: readonly number[]): number | null {
  if (tag === 0x17) {
    if (content.end - content.start !== 13 || bytes[content.start + 12] !== 0x5a) return null;
    const start = content.start;
    const year2 = number(bytes, start, 2);
    const month = number(bytes, start + 2, 2);
    const day = number(bytes, start + 4, 2);
    const hour = number(bytes, start + 6, 2);
    const minute = number(bytes, start + 8, 2);
    const second = number(bytes, start + 10, 2);
    if (year2 === null || month === null || day === null || hour === null || minute === null || second === null) {
      return null;
    }
    // RFC 5280 §4.1.2.5.1: 50...99 => 1950...1999, 00...49 => 2000...2049.
    return makeDate(year2 >= 50 ? 1900 + year2 : 2000 + year2, month, day, hour, minute, second);
  }

  if (tag === 0x18) {
    if (content.end - content.start !== 15 || bytes[content.start + 14] !== 0x5a) return null;
    const start = content.start;
    const year = number(bytes, start, 4);
    const month = number(bytes, start + 4, 2);
    const day = number(bytes, start + 6, 2);
    const hour = number(bytes, start + 8, 2);
    const minute = number(bytes, start + 10, 2);
    const second = number(bytes, start + 12, 2);
    if (year === null || month === null || day === null || hour === null || minute === null || second === null) {
      return null;
    }
    return makeDate(year, month, day, hour, minute, second);
  }

  return null;
}

function validityWindow(der: Uint8Array): Window | null {
  const bytes = Array.from(der);
  if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_BYTES) return null;

  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
  const outer = new DERReader(bytes, 0, bytes.length);
  const certificateContent = outer.read(0x30);
  if (certificateContent === null || !outer.isAtEnd) return null;

  const certificate = new DERReader(bytes, certificateContent.start, certificateContent.end);
  const tbsContent = certificate.read(0x30);
  if (tbsContent === null) return null;
  if (certificate.read(0x30) === null) return null; // signatureAlgorithm
  if (certificate.read(0x03) === null) return null; // signatureValue
  if (!certificate.isAtEnd) return null;

  const tbs = new DERReader(bytes, tbsContent.start, tbsContent.end);

  // Version is DEFAULT v1: absent for v1, otherwise exactly one minimal single-byte INTEGER.
  let version = 0;
  if (tbs.peekTag() === 0xa0) {
    const versionContent = tbs.read(0xa0);
    if (versionContent === null) return null;
    const explicitVersion = new DERReader(bytes, versionContent.start, versionContent.end);
    const versionInteger = explicitVersion.read(0x02);
    if (versionInteger === null || !explicitVersion.isAtEnd) return null;
    const versionValue = singleByteInteger(versionInteger, bytes);
    if (versionValue === null || versionValue > 2) return null;
    version = versionValue;
  }

  // Mandatory fields in RFC 5280 order, including subject and subjectPublicKeyInfo.
  const serialNumberContent = tbs.read(0x02);
  if (serialNumberContent === null || serialNumberContent.end === serialNumberContent.start) return null;
  const signatureContent = tbs.read(0x30);
  if (signatureContent === null || !isAlgorithmIdentifier(signatureContent, bytes)) return null;
  const issuerContent = tbs.read(0x30);
  if (issuerContent === null || issuerContent.end === issuerContent.start) return null;
  if (!isName(issuerContent, bytes)) return null;
  const validityContent = tbs.read(0x30);
  if (validityContent === null) return null;
  const subjectContent = tbs.read(0x30);
  if (subjectContent === null || !isName(subjectContent, bytes)) return null;
  const subjectPublicKeyInfoContent = tbs.read(0x30);
  if (subjectPublicKeyInfoContent === null || !isSubjectPublicKeyInfo(subjectPublicKeyInfoContent, bytes)) {
    return null;
  }

  // Validity ::= SEQUENCE { notBefore Time, notAfter Time }
  const validity = new DERReader(bytes, validityContent.start, validityContent.end);
  const notBeforeTag = validity.peekTag();
  if (notBeforeTag === null || (notBeforeTag !== 0x17 && notBeforeTag !== 0x18)) return null;
  const notBeforeContent = validity.read();
  if (notBeforeContent === null) return null;
  const notAfterTag = validity.peekTag();
  if (notAfterTag === null || (notAfterTag !== 0x17 && notAfterTag !== 0x18)) return null;
  const notAfterContent = validity.read();
  if (notAfterContent === null || !validity.isAtEnd) return null;

  const notBefore = parseTime(notBeforeTag, notBeforeContent, bytes);
  const notAfter = parseTime(notAfterTag, notAfterContent, bytes);
  if (notBefore === null || notAfter === null || notBefore > notAfter) return null;

  // Optional trailing fields: at most once each, in RFC 5280 order, version-gated.
  if (tbs.peekTag() === 0x81) {
    const issuerUniqueID = tbs.read(0x81);
    if (version < 1 || issuerUniqueID === null || !isValidBitStringContent(issuerUniqueID, bytes)) return null;
  }
  if (tbs.peekTag() === 0x82) {
    const subjectUniqueID = tbs.read(0x82);
    if (version < 1 || subjectUniqueID === null || !isValidBitStringContent(subjectUniqueID, bytes)) return null;
  }
  if (tbs.peekTag() === 0xa3) {
    const extensionsContent = tbs.read(0xa3);
    if (version !== 2 || extensionsContent === null || !isExtensions(extensionsContent, bytes)) return null;
  }
  if (!tbs.isAtEnd) return null;

  return { notBefore, notAfter };
}

function evaluate(der: Uint8Array, now: Date = new Date('2030-01-01T00:00:00Z')): Evaluation {
  const window = validityWindow(der);
  if (window === null) return { result: 'malformed', window: null };
  const instant = now.getTime();
  if (instant < window.notBefore) return { result: 'notYetValid', window };
  if (instant > window.notAfter) return { result: 'expired', window };
  return { result: 'valid', window };
}

// ---------------------------------------------------------------------------------------------
// Deterministic DER fixtures (no certificate bytes are read from disk or committed).
// ---------------------------------------------------------------------------------------------

function lengthBytes(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`fixture DER length is not a safe non-negative integer: ${length}`);
  }
  if (length < 0x80) return Buffer.from([length]);
  const encoded: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    encoded.unshift(remaining % 0x100);
    remaining = Math.floor(remaining / 0x100);
  }
  if (encoded.length === 0 || encoded.length > 4) {
    throw new Error(`fixture DER length does not fit in 4 bytes: ${length}`);
  }
  if (encoded[0] === 0 || length < 0x80) {
    throw new Error(`fixture DER length is not minimally encoded: ${length}`);
  }
  return Buffer.from([0x80 | encoded.length, ...encoded]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, ...parts);
}

function setOf(...parts: Buffer[]): Buffer {
  return tlv(0x31, ...parts);
}

function integer(...content: number[]): Buffer {
  return tlv(0x02, Buffer.from(content));
}

function oid(content: Buffer): Buffer {
  return tlv(0x06, content);
}

function utf8String(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, 'utf8'));
}

function nullValue(): Buffer {
  return tlv(0x05);
}

function utcTime(value: string): Buffer {
  return tlv(0x17, Buffer.from(value, 'ascii'));
}

function generalizedTime(value: string): Buffer {
  return tlv(0x18, Buffer.from(value, 'ascii'));
}

function bitString(content: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.from([unusedBits]), content);
}

function octetString(content: Buffer): Buffer {
  return tlv(0x04, content);
}

/** DER BOOLEAN: canonical TRUE is 0xFF, canonical FALSE (which DER must omit) is 0x00. */
function booleanValue(value: boolean): Buffer {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function explicitVersion(value: number | Buffer): Buffer {
  return tlv(0xa0, Buffer.isBuffer(value) ? value : integer(value));
}

/** IMPLICIT BIT STRING carrying fields: content is the BIT STRING content (unused bits first). */
function implicitBitString(contextTag: number, bits: Buffer, unusedBits = 0): Buffer {
  return tlv(0x80 | contextTag, Buffer.from([unusedBits]), bits);
}

const SHA256_WITH_RSA_ENCRYPTION = Buffer.from('2a864886f70d01010b', 'hex');
const RSA_ENCRYPTION = Buffer.from('2a864886f70d010101', 'hex');
const COMMON_NAME = Buffer.from('550403', 'hex');
const BASIC_CONSTRAINTS = Buffer.from('551d13', 'hex');
const KEY_USAGE = Buffer.from('551d0f', 'hex');

const DEFAULT_SERIAL = integer(0x01);
const DEFAULT_SIGNATURE_ALGORITHM = sequence(oid(SHA256_WITH_RSA_ENCRYPTION), nullValue());
const DEFAULT_SPKI = sequence(
  sequence(oid(RSA_ENCRYPTION), nullValue()),
  bitString(Buffer.from('3003020100', 'hex')),
);

/** One `Extension` SEQUENCE from its already-encoded fields. */
function extensionEntry(...fields: Buffer[]): Buffer {
  return sequence(...fields);
}

/** `extensions [3] EXPLICIT Extensions`: exactly one SEQUENCE of the given extensions. */
function extensionsBlock(...extensions: Buffer[]): Buffer {
  return tlv(0xa3, sequence(...extensions));
}

const DEFAULT_EXTENSIONS = extensionsBlock(
  extensionEntry(oid(BASIC_CONSTRAINTS), booleanValue(true), octetString(Buffer.from('3000', 'hex'))),
);
const OUTER_SIGNATURE = bitString(Buffer.from('deadbeef', 'hex'));

function distinguishedName(commonName: string): Buffer {
  return sequence(setOf(sequence(oid(COMMON_NAME), utf8String(commonName))));
}

const DEFAULT_ISSUER = distinguishedName('127.0.0.1');
const DEFAULT_SUBJECT = distinguishedName('127.0.0.1');

function validity(notBefore: Buffer, notAfter: Buffer): Buffer {
  return sequence(notBefore, notAfter);
}

const DEFAULT_VALIDITY = validity(utcTime('250101000000Z'), utcTime('350101000000Z'));

/** The six mandatory TBS fields in RFC 5280 order (version defaults to v1 / absent). */
function defaultTbsFields(): Buffer[] {
  return [
    DEFAULT_SERIAL,
    DEFAULT_SIGNATURE_ALGORITHM,
    DEFAULT_ISSUER,
    DEFAULT_VALIDITY,
    DEFAULT_SUBJECT,
    DEFAULT_SPKI,
  ];
}

function buildCertificate(tbsBytes: Buffer): Buffer {
  return sequence(tbsBytes, DEFAULT_SIGNATURE_ALGORITHM, OUTER_SIGNATURE);
}

function certificateWithFields(fields: Buffer[]): Buffer {
  return buildCertificate(sequence(...fields));
}

/** Frozen so the fixture cannot drift silently: a deliberate change must update this hex. */
const MINIMAL_CERTIFICATE = certificateWithFields(defaultTbsFields());
const FROZEN_MINIMAL_CERTIFICATE_HEX =
  // v1 TBS (no explicit version) + UTCTime 2025-01-01...2035-01-01; 0x30818f exercises the
  // long-form outer length the parser must also accept.
  '30818f3077020101300d06092a864886f70d01010b050030143112301006035504030c093132372e302e302e31301e170d3235303130313030303030305a170d3335303130313030303030305a30143112301006035504030c093132372e302e302e313017300d06092a864886f70d01010105000306003003020100300d06092a864886f70d01010b0500030500deadbeef';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function expectMalformed(label: string, bytes: Uint8Array): void {
  const result = evaluate(bytes);
  assert.equal(result.result, 'malformed', `${label} must be malformed, got ${result.result}`);
  assert.equal(result.window, null, `${label} must not yield a window`);
}

// ---------------------------------------------------------------------------------------------
// Behavioural mirror tests: fixtures -> mirrored parser decisions.
// ---------------------------------------------------------------------------------------------

describe('pinned-ws validity structure (executable mirror): minimal valid forms', () => {
  it('accepts the frozen minimal v1 certificate and reproduces a byte-for-byte fixture', () => {
    assert.equal(
      toHex(MINIMAL_CERTIFICATE),
      FROZEN_MINIMAL_CERTIFICATE_HEX,
      `the minimal fixture must stay reproducible; actual hex: ${toHex(MINIMAL_CERTIFICATE)}`,
    );
    const result = evaluate(MINIMAL_CERTIFICATE);
    assert.equal(result.result, 'valid');
    assert.deepEqual(result.window, {
      notBefore: Date.UTC(2025, 0, 1),
      notAfter: Date.UTC(2035, 0, 1),
    });
  });

  it('accepts a v3 certificate whose subject is empty and whose tail carries extensions', () => {
    const cert = certificateWithFields([
      explicitVersion(2),
      ...defaultTbsFields().slice(0, 4),
      sequence(), // empty subject Name is a legal encoding; policy is not decided here
      DEFAULT_SPKI,
      DEFAULT_EXTENSIONS,
    ]);
    assert.equal(evaluate(cert).result, 'valid');
  });

  it('accepts v2 with issuer and subject unique IDs and no extensions', () => {
    const cert = certificateWithFields([
      explicitVersion(1),
      ...defaultTbsFields(),
      implicitBitString(1, Buffer.from('aa', 'hex')),
      implicitBitString(2, Buffer.from('bb', 'hex')),
    ]);
    assert.equal(evaluate(cert).result, 'valid');
  });

  it('accepts v3 with both unique IDs and ordered extensions', () => {
    const cert = certificateWithFields([
      explicitVersion(2),
      ...defaultTbsFields(),
      implicitBitString(1, Buffer.from('aa', 'hex')),
      implicitBitString(2, Buffer.from('bb', 'hex')),
      DEFAULT_EXTENSIONS,
    ]);
    assert.equal(evaluate(cert).result, 'valid');
  });

  it('accepts an explicit v1 version when the optional tail is absent', () => {
    const cert = certificateWithFields([explicitVersion(0), ...defaultTbsFields()]);
    assert.equal(evaluate(cert).result, 'valid');
  });

  it('accepts multi-RDN and multi-valued-RDN names', () => {
    const multiValued = sequence(
      setOf(sequence(oid(COMMON_NAME), utf8String('a')), sequence(oid(COMMON_NAME), utf8String('b'))),
      setOf(sequence(oid(Buffer.from('55040a', 'hex')), utf8String('org'))),
    );
    const cert = certificateWithFields([
      DEFAULT_SERIAL,
      DEFAULT_SIGNATURE_ALGORITHM,
      multiValued,
      DEFAULT_VALIDITY,
      multiValued,
      DEFAULT_SPKI,
    ]);
    assert.equal(evaluate(cert).result, 'valid');
  });

  it('accepts mixed UTCTime / GeneralizedTime validity encoding', () => {
    const cert = certificateWithFields([
      DEFAULT_SERIAL,
      DEFAULT_SIGNATURE_ALGORITHM,
      DEFAULT_ISSUER,
      validity(generalizedTime('20491231235959Z'), generalizedTime('20510101000000Z')),
      DEFAULT_SUBJECT,
      DEFAULT_SPKI,
    ]);
    const result = evaluate(cert, new Date('2050-06-01T00:00:00Z'));
    assert.equal(result.result, 'valid');
    assert.equal(result.window?.notBefore, Date.UTC(2049, 11, 31, 23, 59, 59));
    assert.equal(result.window?.notAfter, Date.UTC(2051, 0, 1));
  });

  it('accepts the real gateway-shaped certificate generated by selfsigned (real DER, real dates)', async () => {
    const generated = await generateTestCertificate();
    const parsed = new X509Certificate(generated.cert);
    const der = Buffer.from(parsed.raw);

    const result = evaluate(der, new Date());
    assert.equal(result.result, 'valid', 'the parser must accept the certificate shape the gateway serves');
    // OpenSSL's own read of the same DER must agree with the mirror's window, to the second.
    assert.equal(result.window?.notBefore, Date.parse(parsed.validFrom));
    assert.equal(result.window?.notAfter, Date.parse(parsed.validTo));
    // The fixture really exercises a v3 tail: explicit version v3 + basicConstraints extension.
    assert.ok(toHex(der).includes('a003020102'), 'the gateway-shaped fixture must be an explicit v3 TBS');
    assert.ok(toHex(der).includes('551d13'), 'the gateway-shaped fixture must carry the basicConstraints extension');
  });

  it('accepts the exact gateway leaf shape: EC P-256 SPKI plus the gateway extension set', async () => {
    // Mirrors `plugins/mobile-gateway/lib/tls.mjs` (`generateCertificate` + `selfsignedExtensions`):
    // the leaf the Host actually serves is EC, SAN-bearing and v3. A stricter parser that rejected
    // this shape would break pairing for every real gateway, so assert it explicitly.
    const pems = await selfsigned.generate(
      [
        { name: 'commonName', value: '127.0.0.1' },
        { name: 'organizationName', value: 'dsh-ext mobile-gateway' },
      ],
      {
        keyType: 'ec',
        curve: 'P-256',
        algorithm: 'sha256',
        notBeforeDate: new Date(Date.now() - 60_000),
        notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        extensions: [
          { name: 'basicConstraints', cA: false, critical: true },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
        ],
      } as Parameters<typeof selfsigned.generate>[1],
    );

    const parsed = new X509Certificate(pems.cert);
    const der = Buffer.from(parsed.raw);
    const result = evaluate(der, new Date());
    assert.equal(result.result, 'valid');
    assert.equal(result.window?.notBefore, Date.parse(parsed.validFrom));
    assert.equal(result.window?.notAfter, Date.parse(parsed.validTo));

    const hex = toHex(der);
    for (const extensionOid of ['551d13', '551d0f', '551d25', '551d11']) {
      assert.ok(hex.includes(extensionOid), `gateway leaf must carry extension ${extensionOid}`);
    }
    assert.ok(hex.includes('2a8648ce3d0201'), 'gateway leaf must use the EC public-key algorithm OID');
    assert.ok(hex.includes('2a8648ce3d030107'), 'gateway leaf must use the P-256 curve OID');
  });
});

describe('pinned-ws validity structure (executable mirror): truncated or padded TBS tail', () => {
  const fields = defaultTbsFields();

  it('rejects a TBS that stops after Validity (subject and SPKI never read)', () => {
    expectMalformed('truncated after validity', certificateWithFields(fields.slice(0, 4)));
  });

  it('rejects a TBS missing only the mandatory subject', () => {
    const [serial, signature, issuer, validityField, , spki] = fields;
    expectMalformed(
      'missing subject',
      certificateWithFields([serial!, signature!, issuer!, validityField!, spki!]),
    );
  });

  it('rejects a TBS missing only the mandatory SubjectPublicKeyInfo', () => {
    expectMalformed('missing subjectPublicKeyInfo', certificateWithFields(fields.slice(0, 5)));
  });

  it('rejects a truncated SubjectPublicKeyInfo (algorithm but no BIT STRING)', () => {
    const truncatedSpki = sequence(DEFAULT_SIGNATURE_ALGORITHM);
    const cert = certificateWithFields([...fields.slice(0, 5), truncatedSpki]);
    expectMalformed('SPKI without subjectPublicKey', cert);
  });

  it('rejects a SubjectPublicKeyInfo with an extra element after the BIT STRING', () => {
    const paddedSpki = sequence(DEFAULT_SIGNATURE_ALGORITHM, bitString(Buffer.from('00', 'hex')), integer(1));
    expectMalformed('SPKI with trailing element', certificateWithFields([...fields.slice(0, 5), paddedSpki]));
  });

  it('rejects a padded TBS tail after the SubjectPublicKeyInfo', () => {
    expectMalformed('extra OCTET STRING after SPKI', certificateWithFields([...fields, octetString(Buffer.alloc(0))]));
  });

  it('rejects bytes after the optional extensions block', () => {
    const cert = certificateWithFields([explicitVersion(2), ...fields, DEFAULT_EXTENSIONS, octetString(Buffer.alloc(0))]);
    expectMalformed('extra field after extensions', cert);
  });

  it('rejects an unknown context-specific trailing field', () => {
    const cert = certificateWithFields([explicitVersion(2), ...fields, tlv(0x84, Buffer.alloc(0))]);
    expectMalformed('unknown [4] tail', cert);
  });
});

describe('pinned-ws validity structure (executable mirror): optional fields and version gates', () => {
  const fields = defaultTbsFields();

  it('rejects a reordered tail (subjectUniqueID before issuerUniqueID)', () => {
    const cert = certificateWithFields([
      explicitVersion(2),
      ...fields,
      implicitBitString(2, Buffer.from('bb', 'hex')),
      implicitBitString(1, Buffer.from('aa', 'hex')),
    ]);
    expectMalformed('subjectUniqueID before issuerUniqueID', cert);
  });

  it('rejects unique IDs in a v1 certificate', () => {
    const cert = certificateWithFields([...fields, implicitBitString(1, Buffer.from('aa', 'hex'))]);
    expectMalformed('issuerUniqueID in v1', cert);
  });

  it('rejects extensions in a v2 certificate', () => {
    const cert = certificateWithFields([explicitVersion(1), ...fields, DEFAULT_EXTENSIONS]);
    expectMalformed('extensions in v2', cert);
  });

  it('rejects duplicate extensions', () => {
    const cert = certificateWithFields([explicitVersion(2), ...fields, DEFAULT_EXTENSIONS, DEFAULT_EXTENSIONS]);
    expectMalformed('duplicate extensions', cert);
  });

  it('rejects empty or malformed UniqueIdentifier values', () => {
    expectMalformed(
      'empty issuerUniqueID content',
      certificateWithFields([explicitVersion(1), ...fields, tlv(0x81)]),
    );
    expectMalformed(
      'issuerUniqueID with 8 unused bits',
      certificateWithFields([explicitVersion(1), ...fields, implicitBitString(1, Buffer.from('aa', 'hex'), 8)]),
    );
  });

  it('rejects an extensions wrapper that is not exactly one non-empty SEQUENCE', () => {
    const base = [explicitVersion(2), ...fields];
    expectMalformed('extensions wrapper is an INTEGER', certificateWithFields([...base, tlv(0xa3, integer(1))]));
    expectMalformed('extensions wrapper is empty', certificateWithFields([...base, tlv(0xa3, sequence())]));
    expectMalformed(
      'extension element is not a SEQUENCE',
      certificateWithFields([...base, tlv(0xa3, sequence(integer(1)))]),
    );
    expectMalformed(
      'extension element does not start with an OID',
      certificateWithFields([...base, tlv(0xa3, sequence(sequence()))]),
    );
    expectMalformed(
      'extensions wrapper has two SEQUENCEs',
      certificateWithFields([...base, tlv(0xa3, sequence(sequence(oid(BASIC_CONSTRAINTS))), sequence())]),
    );
  });

  it('rejects a version that is not a minimal explicit INTEGER in 0...2', () => {
    const malformedVersions: Buffer[] = [
      explicitVersion(3),
      explicitVersion(255),
      explicitVersion(tlv(0x02, Buffer.from([0x00, 0x01]))), // not single byte / not minimal
      explicitVersion(sequence()), // not an INTEGER at all
      explicitVersion(Buffer.concat([integer(2), integer(0)])), // two INTEGERs
      explicitVersion(Buffer.alloc(0)), // empty [0]
      tlv(0xa0, tlv(0x02, Buffer.from([0x80]))), // 128: two's-complement negative
    ];
    for (const [index, version] of malformedVersions.entries()) {
      expectMalformed(`malformed version #${index}`, certificateWithFields([version, ...fields]));
    }
  });

  it('rejects malformed mandatory fields around the validity window', () => {
    const malformed: Array<[string, Buffer[]]> = [
      ['empty serialNumber', [integer(), DEFAULT_SIGNATURE_ALGORITHM, DEFAULT_ISSUER, DEFAULT_VALIDITY, DEFAULT_SUBJECT, DEFAULT_SPKI]],
      ['signature not a SEQUENCE', [DEFAULT_SERIAL, integer(1), DEFAULT_ISSUER, DEFAULT_VALIDITY, DEFAULT_SUBJECT, DEFAULT_SPKI]],
      ['signature AlgorithmIdentifier without OID', [DEFAULT_SERIAL, sequence(integer(1)), DEFAULT_ISSUER, DEFAULT_VALIDITY, DEFAULT_SUBJECT, DEFAULT_SPKI]],
      ['issuer empty', [DEFAULT_SERIAL, DEFAULT_SIGNATURE_ALGORITHM, sequence(), DEFAULT_VALIDITY, DEFAULT_SUBJECT, DEFAULT_SPKI]],
      ['issuer not a Name', [DEFAULT_SERIAL, DEFAULT_SIGNATURE_ALGORITHM, sequence(integer(1)), DEFAULT_VALIDITY, DEFAULT_SUBJECT, DEFAULT_SPKI]],
      ['subject not a Name', [DEFAULT_SERIAL, DEFAULT_SIGNATURE_ALGORITHM, DEFAULT_ISSUER, DEFAULT_VALIDITY, sequence(integer(1)), DEFAULT_SPKI]],
      ['SPKI algorithm without OID', [DEFAULT_SERIAL, DEFAULT_SIGNATURE_ALGORITHM, DEFAULT_ISSUER, DEFAULT_VALIDITY, DEFAULT_SUBJECT, sequence(sequence(integer(1)), bitString(Buffer.from('00', 'hex')))]],
      ['SPKI empty', [DEFAULT_SERIAL, DEFAULT_SIGNATURE_ALGORITHM, DEFAULT_ISSUER, DEFAULT_VALIDITY, DEFAULT_SUBJECT, sequence()]],
    ];
    for (const [label, malformedFields] of malformed) {
      expectMalformed(label, certificateWithFields(malformedFields));
    }
  });

  it('rejects Validity content that is not exactly two Time values', () => {
    const extraTime = sequence(utcTime('250101000000Z'), utcTime('350101000000Z'), utcTime('400101000000Z'));
    const oneTime = sequence(utcTime('250101000000Z'));
    expectMalformed(
      'validity with three Time values',
      certificateWithFields([DEFAULT_SERIAL, DEFAULT_SIGNATURE_ALGORITHM, DEFAULT_ISSUER, extraTime, DEFAULT_SUBJECT, DEFAULT_SPKI]),
    );
    expectMalformed(
      'validity with one Time value',
      certificateWithFields([DEFAULT_SERIAL, DEFAULT_SIGNATURE_ALGORITHM, DEFAULT_ISSUER, oneTime, DEFAULT_SUBJECT, DEFAULT_SPKI]),
    );
  });
});

describe('pinned-ws validity structure (executable mirror): extension entry shape', () => {
  // v3 TBS whose tail is exactly one `extensions [3] EXPLICIT` block.
  function v3With(extensions: Buffer): Buffer {
    return certificateWithFields([explicitVersion(2), ...defaultTbsFields(), extensions]);
  }

  const BASIC_CONSTRAINTS_VALUE = octetString(Buffer.from('3000', 'hex'));

  it('accepts the legal critical encodings: omitted (DEFAULT FALSE) and canonical TRUE', () => {
    const omitted = v3With(extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS), BASIC_CONSTRAINTS_VALUE)));
    const criticalTrue = v3With(
      extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS), booleanValue(true), BASIC_CONSTRAINTS_VALUE)),
    );
    const mixed = v3With(
      extensionsBlock(
        extensionEntry(oid(BASIC_CONSTRAINTS), booleanValue(true), BASIC_CONSTRAINTS_VALUE),
        // An opaque payload: nothing here decodes keyUsage.
        extensionEntry(oid(KEY_USAGE), octetString(Buffer.from('03020780', 'hex'))),
      ),
    );
    for (const [label, cert] of [
      ['omitted critical', omitted],
      ['critical TRUE', criticalTrue],
      ['mixed extensions', mixed],
    ] as const) {
      assert.equal(evaluate(cert).result, 'valid', `${label} must be accepted`);
    }
  });

  it('rejects an OID-only extension (extnValue missing)', () => {
    expectMalformed('OID-only extension', v3With(extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS)))));
  });

  it('rejects a missing extnValue after the critical flag', () => {
    expectMalformed(
      'critical TRUE without extnValue',
      v3With(extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS), booleanValue(true)))),
    );
  });

  it('rejects an encoded DEFAULT critical FALSE and non-canonical BOOLEANs', () => {
    // DER forbids encoding the DEFAULT FALSE; a TRUE other than 0xFF is BER, not DER.
    expectMalformed(
      'critical FALSE encoded',
      v3With(extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS), booleanValue(false), BASIC_CONSTRAINTS_VALUE))),
    );
    expectMalformed(
      'non-canonical TRUE (0x01)',
      v3With(
        extensionsBlock(
          extensionEntry(oid(BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0x01])), BASIC_CONSTRAINTS_VALUE),
        ),
      ),
    );
    expectMalformed(
      'empty BOOLEAN content',
      v3With(extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS), tlv(0x01), BASIC_CONSTRAINTS_VALUE))),
    );
    expectMalformed(
      'two-byte BOOLEAN content',
      v3With(
        extensionsBlock(
          extensionEntry(oid(BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff, 0x00])), BASIC_CONSTRAINTS_VALUE),
        ),
      ),
    );
  });

  it('rejects garbage or trailing fields where extnValue belongs', () => {
    expectMalformed(
      'INTEGER instead of extnValue',
      v3With(extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS), integer(1)))),
    );
    expectMalformed(
      'two OCTET STRINGs after the OID',
      v3With(extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS), BASIC_CONSTRAINTS_VALUE, BASIC_CONSTRAINTS_VALUE))),
    );
    expectMalformed(
      'duplicated critical BOOLEAN',
      v3With(
        extensionsBlock(
          extensionEntry(
            oid(BASIC_CONSTRAINTS),
            booleanValue(true),
            booleanValue(true),
            BASIC_CONSTRAINTS_VALUE,
          ),
        ),
      ),
    );
  });

  it('rejects the same extnID twice inside one Extensions SEQUENCE (RFC 5280 §4.2)', () => {
    expectMalformed(
      'duplicate extnID',
      v3With(
        extensionsBlock(
          extensionEntry(oid(BASIC_CONSTRAINTS), BASIC_CONSTRAINTS_VALUE),
          extensionEntry(oid(BASIC_CONSTRAINTS), booleanValue(true), BASIC_CONSTRAINTS_VALUE),
        ),
      ),
    );
  });

  it('accepts an empty extnValue OCTET STRING: the payload is opaque, not semantically validated', () => {
    const cert = v3With(extensionsBlock(extensionEntry(oid(BASIC_CONSTRAINTS), octetString(Buffer.alloc(0)))));
    assert.equal(evaluate(cert).result, 'valid');
  });

  it('rejects empty wrappers and non-SEQUENCE entries', () => {
    expectMalformed('empty Extensions SEQUENCE', v3With(tlv(0xa3, sequence())));
    expectMalformed('empty extension SEQUENCE', v3With(extensionsBlock(sequence())));
    expectMalformed('non-SEQUENCE extension entry', v3With(tlv(0xa3, sequence(integer(1)))));
  });
});

describe('pinned-ws validity structure (executable mirror): outer certificate bounds', () => {
  const fields = defaultTbsFields();

  it('rejects empty input and oversized input', () => {
    expectMalformed('empty input', Buffer.alloc(0));
    expectMalformed('one byte past the defensive bound', Buffer.alloc(MAX_CERTIFICATE_BYTES + 1));
  });

  it('rejects bytes after the outer Certificate SEQUENCE', () => {
    expectMalformed('trailing byte after certificate', Buffer.concat([MINIMAL_CERTIFICATE, Buffer.from([0x00])]));
  });

  it('rejects an extra element inside the outer Certificate SEQUENCE', () => {
    const cert = tlv(
      0x30,
      sequence(...fields),
      DEFAULT_SIGNATURE_ALGORITHM,
      OUTER_SIGNATURE,
      octetString(Buffer.alloc(0)),
    );
    expectMalformed('extra element inside certificate', cert);
  });

  it('rejects indefinite and non-minimal outer lengths', () => {
    const content = Buffer.concat([sequence(...fields), DEFAULT_SIGNATURE_ALGORITHM, OUTER_SIGNATURE]);
    expectMalformed(
      'indefinite outer length',
      Buffer.concat([Buffer.from([0x30, 0x80]), content, Buffer.from([0x00, 0x00])]),
    );
    expectMalformed(
      'long-form length with a leading zero',
      Buffer.concat([Buffer.from([0x30, 0x82, 0x00, content.length]), content]),
    );
    expectMalformed(
      'length-of-length 5',
      Buffer.concat([Buffer.from([0x30, 0x85, 0x00, 0x00, 0x00, 0x01, 0x00]), content]),
    );
  });

  it('rejects every strict prefix of the frozen certificate', () => {
    for (let length = 0; length < MINIMAL_CERTIFICATE.length; length += 1) {
      expectMalformed(
        `prefix of ${length}/${MINIMAL_CERTIFICATE.length} bytes`,
        MINIMAL_CERTIFICATE.subarray(0, length),
      );
    }
  });

  it('never throws and never leaves the four results for single-byte mutations', () => {
    const allowed: PinnedWsValidityResult[] = ['valid', 'expired', 'notYetValid', 'malformed'];
    for (let index = 0; index < MINIMAL_CERTIFICATE.length; index += 1) {
      const mutated = Buffer.from(MINIMAL_CERTIFICATE);
      mutated[index] = (mutated[index] ?? 0) ^ 0xff;
      const result = evaluate(mutated).result;
      assert.ok(allowed.includes(result), `mutation at byte ${index} returned ${result}`);
    }
  });
});

describe('pinned-ws validity structure (executable mirror): strict time values', () => {
  function withValidity(notBefore: Buffer, notAfter: Buffer): Buffer {
    return certificateWithFields([
      DEFAULT_SERIAL,
      DEFAULT_SIGNATURE_ALGORITHM,
      DEFAULT_ISSUER,
      validity(notBefore, notAfter),
      DEFAULT_SUBJECT,
      DEFAULT_SPKI,
    ]);
  }

  const window = withValidity(utcTime('300101000000Z'), utcTime('310101000000Z'));
  const notBefore = Date.UTC(2030, 0, 1);
  const notAfter = Date.UTC(2031, 0, 1);

  it('treats the window as inclusive and classifies by clock', () => {
    assert.equal(evaluate(window, new Date(notBefore)).result, 'valid');
    assert.equal(evaluate(window, new Date(notAfter)).result, 'valid');
    assert.equal(evaluate(window, new Date(notBefore - 1)).result, 'notYetValid');
    assert.equal(evaluate(window, new Date(notAfter + 1)).result, 'expired');
  });

  it('rejects a notBefore after notAfter', () => {
    expectMalformed('inverted window', withValidity(utcTime('350101000000Z'), utcTime('250101000000Z')));
  });

  it('applies the UTCTime 1950/2049 pivot', () => {
    const pivoted = withValidity(utcTime('500101000000Z'), utcTime('491231235959Z'));
    const result = evaluate(pivoted, new Date('1970-01-01T00:00:00Z'));
    assert.equal(result.result, 'valid');
    assert.equal(result.window?.notBefore, Date.UTC(1950, 0, 1));
    assert.equal(result.window?.notAfter, Date.UTC(2049, 11, 31, 23, 59, 59));
  });

  it('reads a pre-2050 GeneralizedTime as deliberate read compatibility, not an issuance profile', () => {
    // RFC 5280 §4.1.2.5 asks issuers to use UTCTime below 2050; some gateways emit
    // GeneralizedTime for every date. Both are read on purpose so a real pinned leaf still works;
    // this is the documented leniency, NOT a licence for issuers, and not a strictness regression.
    const cert = withValidity(generalizedTime('20250101000000Z'), generalizedTime('20350101000000Z'));
    const result = evaluate(cert, new Date(Date.UTC(2030, 0, 1)));
    assert.equal(result.result, 'valid');
    assert.equal(result.window?.notBefore, Date.UTC(2025, 0, 1));
    assert.equal(result.window?.notAfter, Date.UTC(2035, 0, 1));
  });

  it('rejects offsets, missing seconds/Z, and calendar-invalid dates', () => {
    const invalid: Array<[number, string, string]> = [
      [0x17, '25010100000Z', 'UTCTime without seconds'],
      [0x17, '250101000000', 'UTCTime without Z'],
      [0x17, '250101000000z', 'UTCTime with lowercase z'],
      [0x17, '250101000000+0000', 'UTCTime with an offset'],
      [0x17, '250132000000Z', 'month 13'],
      [0x17, '250230000000Z', 'February 30'],
      [0x17, '250101240000Z', 'hour 24'],
      [0x17, '250101006000Z', 'minute 60'],
      [0x17, '250101000060Z', 'second 60'],
      [0x17, '25010a000000Z', 'non-digit'],
      [0x18, '20260230000000Z', 'GeneralizedTime February 30'],
      [0x18, '20250101000000', 'GeneralizedTime without Z'],
      [0x18, '2025010100000Z', 'GeneralizedTime without seconds'],
    ];
    for (const [tag, text, label] of invalid) {
      const time = tag === 0x17 ? utcTime(text) : generalizedTime(text);
      expectMalformed(label, withValidity(time, utcTime('350101000000Z')));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Static guards: the Swift source must keep the structure the mirror above describes.
// ---------------------------------------------------------------------------------------------

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function markerIndex(source: string, marker: string): number {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `Swift source no longer contains ${JSON.stringify(marker)}`);
  return index;
}

function sliceBetween(source: string, from: string, to: string): string {
  const start = markerIndex(source, from);
  const end = markerIndex(source, to);
  assert.ok(end > start, `${JSON.stringify(to)} must appear after ${JSON.stringify(from)}`);
  return source.slice(start, end);
}

describe('pinned-ws validity structure (Swift source guards)', () => {
  const swift = read(SWIFT_VALIDITY);

  it('consumes the whole TBS: subject and SPKI after Validity, then a strict end-of-TBS check', () => {
    const validityRead = markerIndex(swift, 'let validityContent = tbs.read(tag: 0x30)');
    const subjectRead = markerIndex(swift, 'let subjectContent = tbs.read(tag: 0x30)');
    const subjectShape = markerIndex(swift, 'isName(subjectContent, bytes: bytes)');
    const spkiRead = markerIndex(swift, 'let subjectPublicKeyInfoContent = tbs.read(tag: 0x30)');
    const spkiShape = markerIndex(swift, 'isSubjectPublicKeyInfo(subjectPublicKeyInfoContent, bytes: bytes)');
    const extensionsBlock = markerIndex(swift, 'if tbs.peekTag() == 0xA3 {');
    const endOfTbs = markerIndex(swift, 'guard tbs.isAtEnd else { return nil }');

    assert.ok(subjectRead > validityRead, 'subject must be read after Validity, not skipped');
    assert.ok(subjectShape > subjectRead, 'the subject Name must be structurally checked');
    assert.ok(spkiRead > subjectShape, 'subjectPublicKeyInfo must be read after the subject');
    assert.ok(spkiShape > spkiRead, 'the SPKI must be structurally checked');
    assert.ok(extensionsBlock > spkiShape, 'optional fields must follow the mandatory tail');
    assert.ok(endOfTbs > extensionsBlock, 'the TBS must be fully consumed after the optional fields');

    // There is exactly one Window construction, and it happens only after the end-of-TBS check.
    const windowConstructions = swift.match(/return Window\(notBefore: notBefore, notAfter: notAfter\)/g) ?? [];
    assert.equal(windowConstructions.length, 1, 'there must be a single Window construction');
    assert.ok(markerIndex(swift, 'return Window(notBefore: notBefore, notAfter: notAfter)') > endOfTbs);
  });

  it('decodes the version as an explicit minimal single-byte INTEGER in 0...2', () => {
    assert.match(swift, /var version = 0/);
    const versionGate = sliceBetween(swift, 'if tbs.peekTag() == 0xA0 {', '// The mandatory fields in RFC 5280 order.');
    assert.match(versionGate, /explicitVersion\.read\(tag: 0x02\)/);
    assert.match(versionGate, /explicitVersion\.isAtEnd/);
    assert.match(versionGate, /let versionValue = singleByteInteger\(versionInteger, bytes: bytes\)/);
    assert.match(versionGate, /versionValue <= 2/);
    assert.match(versionGate, /version = versionValue/);
  });

  it('gates the optional fields on the version and keeps RFC 5280 order', () => {
    const issuerUniqueID = sliceBetween(swift, 'if tbs.peekTag() == 0x81 {', 'if tbs.peekTag() == 0x82 {');
    assert.match(issuerUniqueID, /guard version >= 1/);
    assert.match(issuerUniqueID, /tbs\.read\(tag: 0x81\)/);
    assert.match(issuerUniqueID, /isValidBitStringContent\(issuerUniqueID/);

    const subjectUniqueID = sliceBetween(swift, 'if tbs.peekTag() == 0x82 {', 'if tbs.peekTag() == 0xA3 {');
    assert.match(subjectUniqueID, /guard version >= 1/);
    assert.match(subjectUniqueID, /tbs\.read\(tag: 0x82\)/);
    assert.match(subjectUniqueID, /isValidBitStringContent\(subjectUniqueID/);

    const extensions = sliceBetween(swift, 'if tbs.peekTag() == 0xA3 {', 'guard tbs.isAtEnd else { return nil }');
    assert.match(extensions, /guard version == 2/);
    assert.match(extensions, /tbs\.read\(tag: 0xA3\)/);
    assert.match(extensions, /isExtensions\(extensionsContent/);
  });

  it('consumes each Extension field-by-field: OID, optional canonical critical, extnValue, end', () => {
    const extension = sliceBetween(swift, 'private static func isExtensions(', '// MARK: - Time values');
    // extnID: required, non-empty, and refused a second time (RFC 5280 §4.2).
    assert.match(extension, /read\(tag: 0x06\), !extnID\.isEmpty/);
    assert.match(
      extension,
      /guard !seenExtensionIds\.contains\(where: \{ bytes\[\$0\] == bytes\[extnID\] \}\) else \{ return false \}/,
    );
    // critical: optional, and when present DER-canonical TRUE only (the DEFAULT FALSE is omitted).
    assert.match(extension, /if extensionFields\.peekTag\(\) == 0x01 \{/);
    assert.match(extension, /critical\.count == 1/);
    assert.match(extension, /bytes\[critical\.lowerBound\] == 0xFF/);
    // extnValue: required OCTET STRING, and nothing may follow it inside the entry.
    const extnValue = markerIndex(extension, 'extensionFields.read(tag: 0x04)');
    const endOfEntry = markerIndex(extension, 'extensionFields.isAtEnd');
    assert.ok(endOfEntry > extnValue, 'an Extension must be fully consumed after its extnValue');
    // The OID-only shape that used to be enough is gone: all three reads must pass.
    assert.doesNotMatch(extension, /guard let oid = extensionFields\.read\(tag: 0x06\)/);
  });

  it('keeps the structural helpers the mirror was derived from', () => {
    for (const helper of [
      'singleByteInteger',
      'isAlgorithmIdentifier',
      'isName',
      'isSubjectPublicKeyInfo',
      'isValidBitStringContent',
      'isExtensions',
    ]) {
      assert.match(swift, new RegExp(`private static func ${helper}\\(`), `helper ${helper} is gone`);
    }
    // The markers `pinned-ws-native.test.ts` relies on must survive.
    assert.match(swift, /\/\/ serialNumber/);
    assert.match(swift, /\/\/ issuer Name/);
  });

  it('keeps the bounded reader and strict dates unchanged', () => {
    assert.match(swift, /private static let maxCertificateBytes = 1 << 20/);
    assert.match(swift, /guard !bytes\.isEmpty, bytes\.count <= maxCertificateBytes else \{ return nil \}/);
    assert.match(swift, /content\.count == 13/);
    assert.match(swift, /content\.count == 15/);
    assert.match(swift, /bytes\[content\.lowerBound \+ 12\] == 0x5A/);
    assert.match(swift, /bytes\[content\.lowerBound \+ 14\] == 0x5A/);
    assert.match(swift, /year2 >= 50 \? 1900 \+ year2 : 2000 \+ year2/);
    assert.match(swift, /\(1950\.\.\.9999\)\.contains\(year\)/);
    assert.match(swift, /roundtrip\.year == year/);
    assert.match(swift, /notBefore <= notAfter/);
    assert.match(swift, /guard let window = validityWindow\(in: der\) else \{ return \.malformed \}/);
  });

  it('stays fail-closed: no trapping, no reflection, no macOS-only API', () => {
    for (const pattern of [
      /\btry!/,
      /fatalError/,
      /preconditionFailure/,
      /\bMirror\s*\(/,
      /NSClassFromString|NSSelectorFromString/,
      /\bobjc_/,
      /performSelector/,
      /SecCertificateCopyValues/,
      /SecTrustEvaluateWithError/,
      /SecTrustSetAnchorCertificates/,
      /SecCertificateCopySubjectSummary/,
      /#if os\(macOS\)/,
      /import AppKit/,
      /@available\(/,
    ]) {
      assert.doesNotMatch(swift, pattern, `PinnedWsValidity must not use ${pattern}`);
    }
    // Only the two frameworks the parser needs; adding UIKit/AppKit here would be a smell.
    const imports = [...swift.matchAll(/^import (\w+)$/gm)].map((match) => match[1]).sort();
    assert.deepEqual(imports, ['Foundation', 'Security']);
  });

  it('does not raise the iOS deployment floor or the Swift language version', () => {
    const podspec = read(PODSPEC);
    assert.match(podspec, /:ios => '16\.4'/);
    assert.match(podspec, /s\.swift_version\s*= '5\.9'/);
  });
});
