import Foundation
import Security

/// Result of checking the pinned leaf's X.509 validity window.
enum PinnedWsValidityResult {
  case valid
  case expired
  case notYetValid
  case malformed
}

/**
 Checks the `Validity` field of the pinned leaf certificate against the device clock.

 The pin (SHA-256 of the leaf DER bytes) proves *which* certificate was paired; it does not prove
 that the host owner extended that certificate. An expired or not-yet-valid pinned leaf is a
 rotated/expired identity and must be refused before the handshake credential is used, otherwise a
 stale certificate would keep authorizing the upgrade request.

 This reads the two RFC 5280 `Time` values straight out of the DER. Reading the field directly
 makes the rejection explicit and independent of how `SecTrust` treats a self-signed leaf used as
 an explicit anchor; no CA path evaluation is involved. The parser is deliberately small, bounded
 and strict (definite lengths, minimal length encoding, exactly `YYMMDDHHMMSSZ` /
 `YYYYMMDDHHMMSSZ`, Gregorian round-trip). Any input it cannot read fully is rejected
 (`.malformed`), never treated as valid.

 The whole `TBSCertificate` has to be consumed, not just the fields up to `Validity`: the explicit
 version, the mandatory `subject` `Name` and `SubjectPublicKeyInfo`, the version-gated optional
 `issuerUniqueID` / `subjectUniqueID` / `extensions` in RFC 5280 order, and a final
 end-of-TBS check. Each `Extension` in that tail is consumed field-by-field too (`extnID`,
 optional canonical-DER `critical`, required `extnValue`), so an OID-only or padded entry cannot
 slip through on its wrapper alone. A truncated TBS or one with an unknown, duplicated, reordered
 or trailing field is `.malformed` as well. These are structural checks (plus the mandatory
 fields' shape), not a cryptographic certificate validator: `SecCertificate` has already parsed
 the outer DER and the pin authenticates the exact bytes.

 The certificates examined here already matched a 256-bit pin, so this is defence in depth over an
 authenticated value, not a parser for arbitrary untrusted input. It still fails closed.
 */
enum PinnedWsValidity {
  /// Defensive bound: a certificate this large cannot be a gateway leaf.
  private static let maxCertificateBytes = 1 << 20

  static func evaluate(_ certificate: SecCertificate, now: Date = Date()) -> PinnedWsValidityResult {
    let der = SecCertificateCopyData(certificate) as Data
    guard let window = validityWindow(in: der) else { return .malformed }
    if now < window.notBefore { return .notYetValid }
    if now > window.notAfter { return .expired }
    return .valid
  }

  private struct Window {
    let notBefore: Date
    let notAfter: Date
  }

  private static func validityWindow(in der: Data) -> Window? {
    let bytes = [UInt8](der)
    guard !bytes.isEmpty, bytes.count <= maxCertificateBytes else { return nil }

    // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
    var outer = DERRange(bytes: bytes, start: 0, end: bytes.count)
    guard let certificateContent = outer.read(tag: 0x30), outer.isAtEnd else { return nil }

    var certificate = DERRange(
      bytes: bytes,
      start: certificateContent.lowerBound,
      end: certificateContent.upperBound
    )
    guard let tbsContent = certificate.read(tag: 0x30),
          certificate.read(tag: 0x30) != nil, // signatureAlgorithm
          certificate.read(tag: 0x03) != nil, // signatureValue
          certificate.isAtEnd else { return nil }

    // TBSCertificate ::= SEQUENCE {
    //   version [0] EXPLICIT Version DEFAULT v1,
    //   serialNumber CertificateSerialNumber,
    //   signature AlgorithmIdentifier,
    //   issuer Name,
    //   validity Validity,
    //   subject Name,
    //   subjectPublicKeyInfo SubjectPublicKeyInfo,
    //   issuerUniqueID [1] IMPLICIT UniqueIdentifier OPTIONAL, -- v2 or v3
    //   subjectUniqueID [2] IMPLICIT UniqueIdentifier OPTIONAL, -- v2 or v3
    //   extensions [3] EXPLICIT Extensions OPTIONAL -- v3 only
    // }
    var tbs = DERRange(bytes: bytes, start: tbsContent.lowerBound, end: tbsContent.upperBound)

    // Version is DEFAULT v1: absent for v1, otherwise exactly one minimal single-byte INTEGER.
    // Version ::= INTEGER { v1(0), v2(1), v3(2) }; anything else is not a certificate we know.
    var version = 0
    if tbs.peekTag() == 0xA0 {
      guard let versionContent = tbs.read(tag: 0xA0) else { return nil }
      var explicitVersion = DERRange(
        bytes: bytes,
        start: versionContent.lowerBound,
        end: versionContent.upperBound
      )
      guard let versionInteger = explicitVersion.read(tag: 0x02),
            explicitVersion.isAtEnd,
            let versionValue = singleByteInteger(versionInteger, bytes: bytes),
            versionValue <= 2 else { return nil }
      version = versionValue
    }

    // The mandatory fields in RFC 5280 order. `subject` and `subjectPublicKeyInfo` MUST be
    // consumed here too: stopping after Validity would accept a TBS whose tail was never read.
    guard let serialNumberContent = tbs.read(tag: 0x02), !serialNumberContent.isEmpty, // serialNumber
          let signatureContent = tbs.read(tag: 0x30), // signature AlgorithmIdentifier
          isAlgorithmIdentifier(signatureContent, bytes: bytes),
          let issuerContent = tbs.read(tag: 0x30), !issuerContent.isEmpty, // issuer Name
          isName(issuerContent, bytes: bytes),
          let validityContent = tbs.read(tag: 0x30),
          let subjectContent = tbs.read(tag: 0x30),
          isName(subjectContent, bytes: bytes),
          let subjectPublicKeyInfoContent = tbs.read(tag: 0x30),
          isSubjectPublicKeyInfo(subjectPublicKeyInfoContent, bytes: bytes) else { return nil }

    // Validity ::= SEQUENCE { notBefore Time, notAfter Time }
    var validity = DERRange(
      bytes: bytes,
      start: validityContent.lowerBound,
      end: validityContent.upperBound
    )
    guard let notBeforeTag = validity.peekTag(),
          notBeforeTag == 0x17 || notBeforeTag == 0x18,
          let notBeforeContent = validity.read(),
          let notAfterTag = validity.peekTag(),
          notAfterTag == 0x17 || notAfterTag == 0x18,
          let notAfterContent = validity.read(),
          validity.isAtEnd else { return nil }

    guard let notBefore = parseTime(tag: notBeforeTag, content: notBeforeContent, bytes: bytes),
          let notAfter = parseTime(tag: notAfterTag, content: notAfterContent, bytes: bytes),
          notBefore <= notAfter else { return nil }

    // Optional trailing fields: at most once each, in RFC 5280 order, and only for the versions
    // that define them (unique IDs: v2/v3; extensions: v3). A duplicate, reordered, unknown or
    // leftover field fails the end-of-TBS check below, so a padded or truncated tail cannot be
    // mistaken for a valid certificate.
    if tbs.peekTag() == 0x81 {
      guard version >= 1,
            let issuerUniqueID = tbs.read(tag: 0x81),
            isValidBitStringContent(issuerUniqueID, bytes: bytes) else { return nil }
    }
    if tbs.peekTag() == 0x82 {
      guard version >= 1,
            let subjectUniqueID = tbs.read(tag: 0x82),
            isValidBitStringContent(subjectUniqueID, bytes: bytes) else { return nil }
    }
    if tbs.peekTag() == 0xA3 {
      guard version == 2,
            let extensionsContent = tbs.read(tag: 0xA3),
            isExtensions(extensionsContent, bytes: bytes) else { return nil }
    }
    guard tbs.isAtEnd else { return nil }

    return Window(notBefore: notBefore, notAfter: notAfter)
  }

  // MARK: - Structural shape of the remaining TBSCertificate fields

  /// A minimal single-byte INTEGER (0...255). Callers range-check the value; two's-complement
  /// negatives show up as >= 0x80 and are refused by that range check.
  private static func singleByteInteger(_ content: Range<Int>, bytes: [UInt8]) -> Int? {
    guard content.count == 1 else { return nil }
    return Int(bytes[content.lowerBound])
  }

  /// `AlgorithmIdentifier ::= SEQUENCE { algorithm OBJECT IDENTIFIER, parameters ANY OPTIONAL }`.
  private static func isAlgorithmIdentifier(_ content: Range<Int>, bytes: [UInt8]) -> Bool {
    var algorithm = DERRange(bytes: bytes, start: content.lowerBound, end: content.upperBound)
    guard let oid = algorithm.read(tag: 0x06), !oid.isEmpty else { return false }
    if !algorithm.isAtEnd {
      guard algorithm.read() != nil, algorithm.isAtEnd else { return false }
    }
    return true
  }

  /// `Name ::= CHOICE { rdnSequence RDNSequence }`; every child of the SEQUENCE is a SET.
  /// An empty SEQUENCE is still a well-formed name encoding.
  private static func isName(_ content: Range<Int>, bytes: [UInt8]) -> Bool {
    var name = DERRange(bytes: bytes, start: content.lowerBound, end: content.upperBound)
    while !name.isAtEnd {
      guard name.read(tag: 0x31) != nil else { return false }
    }
    return true
  }

  /// `SubjectPublicKeyInfo ::= SEQUENCE { algorithm AlgorithmIdentifier, subjectPublicKey BIT STRING }`.
  private static func isSubjectPublicKeyInfo(_ content: Range<Int>, bytes: [UInt8]) -> Bool {
    var subjectPublicKeyInfo = DERRange(
      bytes: bytes,
      start: content.lowerBound,
      end: content.upperBound
    )
    guard let algorithmContent = subjectPublicKeyInfo.read(tag: 0x30),
          isAlgorithmIdentifier(algorithmContent, bytes: bytes),
          let subjectPublicKey = subjectPublicKeyInfo.read(tag: 0x03),
          isValidBitStringContent(subjectPublicKey, bytes: bytes),
          subjectPublicKeyInfo.isAtEnd else { return false }
    return true
  }

  /// `BIT STRING` content starts with the number of unused trailing bits; DER allows 0...7.
  /// Used for the `subjectPublicKeyInfo` key and for the IMPLICIT `UniqueIdentifier` fields.
  private static func isValidBitStringContent(_ content: Range<Int>, bytes: [UInt8]) -> Bool {
    guard !content.isEmpty else { return false }
    return bytes[content.lowerBound] <= 7
  }

  /// `Extensions ::= SEQUENCE SIZE (1..MAX) OF Extension`. Every `Extension` is consumed whole:
  ///
  ///   Extension ::= SEQUENCE {
  ///     extnID OBJECT IDENTIFIER,
  ///     critical BOOLEAN DEFAULT FALSE,
  ///     extnValue OCTET STRING
  ///   }
  ///
  /// `critical` is optional. DER forbids encoding the DEFAULT value, so when the BOOLEAN is
  /// present it must be the canonical `01 01 FF` (one content byte, TRUE); an encoded FALSE
  /// (`01 01 00`) is a non-DER default and is refused like every other malformed shape: an
  /// OID-only extension, a missing or duplicated `extnValue`, trailing bytes, a repeated
  /// `extnID`, and empty wrappers. `extnValue` is opaque here — its presence and TLV shape are
  /// checked, the extension semantics inside it (basicConstraints, keyUsage, EKU, ...) are not.
  private static func isExtensions(_ content: Range<Int>, bytes: [UInt8]) -> Bool {
    var wrapper = DERRange(bytes: bytes, start: content.lowerBound, end: content.upperBound)
    guard let extensionsContent = wrapper.read(tag: 0x30), wrapper.isAtEnd else { return false }
    var extensions = DERRange(
      bytes: bytes,
      start: extensionsContent.lowerBound,
      end: extensionsContent.upperBound
    )
    guard !extensions.isAtEnd else { return false }
    // RFC 5280 §4.2: "A certificate MUST NOT include more than one instance of a particular
    // extension." Comparing the raw OID content is enough for that (no semantic decoding).
    var seenExtensionIds: [Range<Int>] = []
    while !extensions.isAtEnd {
      guard let extensionContent = extensions.read(tag: 0x30) else { return false }
      var extensionFields = DERRange(
        bytes: bytes,
        start: extensionContent.lowerBound,
        end: extensionContent.upperBound
      )
      guard let extnID = extensionFields.read(tag: 0x06), !extnID.isEmpty else { return false }
      guard !seenExtensionIds.contains(where: { bytes[$0] == bytes[extnID] }) else { return false }
      seenExtensionIds.append(extnID)
      if extensionFields.peekTag() == 0x01 {
        guard let critical = extensionFields.read(tag: 0x01),
              critical.count == 1,
              bytes[critical.lowerBound] == 0xFF else { return false }
      }
      guard extensionFields.read(tag: 0x04) != nil, // extnValue, opaque
            extensionFields.isAtEnd else { return false }
    }
    return true
  }

  // MARK: - Time values

  /// `UTCTime` (tag 0x17) is `YYMMDDHHMMSSZ`; `GeneralizedTime` (tag 0x18) is
  /// `YYYYMMDDHHMMSSZ`. RFC 5280 requires seconds and the `Z` suffix; offsets, fractional
  /// seconds and missing seconds are rejected.
  ///
  /// Deliberate read compatibility, not a strict issuance profile: RFC 5280 §4.1.2.5 says an
  /// issuer encodes 1950...2049 as `UTCTime` and 2050...9999 as `GeneralizedTime`, so a
  /// pre-2050 `GeneralizedTime` is non-conforming. The parser still reads it (the
  /// 1950...9999 floor in `makeDate` below), because some gateways and TLS proxies emit
  /// `GeneralizedTime` for every date and refusing that shape would reject a certificate the
  /// host really serves — and this value is already authenticated by the pin. Rejecting
  /// `GeneralizedTime` below 2050 here would be a policy change, not a parser fix.
  private static func parseTime(tag: UInt8, content: Range<Int>, bytes: [UInt8]) -> Date? {
    switch tag {
    case 0x17:
      guard content.count == 13, bytes[content.lowerBound + 12] == 0x5A else { return nil }
      let start = content.lowerBound
      guard let year2 = number(bytes, start, 2),
            let month = number(bytes, start + 2, 2),
            let day = number(bytes, start + 4, 2),
            let hour = number(bytes, start + 6, 2),
            let minute = number(bytes, start + 8, 2),
            let second = number(bytes, start + 10, 2) else { return nil }
      // RFC 5280 §4.1.2.5.1: 50...99 => 1950...1999, 00...49 => 2000...2049.
      let year = year2 >= 50 ? 1900 + year2 : 2000 + year2
      return makeDate(year: year, month: month, day: day, hour: hour, minute: minute, second: second)

    case 0x18:
      guard content.count == 15, bytes[content.lowerBound + 14] == 0x5A else { return nil }
      let start = content.lowerBound
      guard let year = number(bytes, start, 4),
            let month = number(bytes, start + 4, 2),
            let day = number(bytes, start + 6, 2),
            let hour = number(bytes, start + 8, 2),
            let minute = number(bytes, start + 10, 2),
            let second = number(bytes, start + 12, 2) else { return nil }
      return makeDate(year: year, month: month, day: day, hour: hour, minute: minute, second: second)

    default:
      return nil
    }
  }

  /// Decimal digits only; no sign, no whitespace, no padding tolerance.
  private static func number(_ bytes: [UInt8], _ start: Int, _ count: Int) -> Int? {
    guard start >= 0, count > 0, start + count <= bytes.count else { return nil }
    var value = 0
    for index in start..<(start + count) {
      let byte = bytes[index]
      guard byte >= 0x30, byte <= 0x39 else { return nil }
      value = value * 10 + Int(byte - 0x30)
    }
    return value
  }

  /// Builds the UTC instant and requires the Gregorian calendar to give back exactly the same
  /// components, so `20260230`, month 13, hour 24, etc. are rejected instead of normalized.
  private static func makeDate(
    year: Int,
    month: Int,
    day: Int,
    hour: Int,
    minute: Int,
    second: Int
  ) -> Date? {
    guard (1950...9999).contains(year),
          (1...12).contains(month),
          (1...31).contains(day),
          (0...23).contains(hour),
          (0...59).contains(minute),
          (0...59).contains(second) else { return nil }

    var calendar = Calendar(identifier: .gregorian)
    guard let utc = TimeZone(secondsFromGMT: 0) else { return nil }
    calendar.timeZone = utc

    var components = DateComponents()
    components.calendar = calendar
    components.timeZone = utc
    components.year = year
    components.month = month
    components.day = day
    components.hour = hour
    components.minute = minute
    components.second = second
    guard let date = calendar.date(from: components) else { return nil }

    let roundtrip = calendar.dateComponents(
      [.year, .month, .day, .hour, .minute, .second],
      from: date
    )
    guard roundtrip.year == year,
          roundtrip.month == month,
          roundtrip.day == day,
          roundtrip.hour == hour,
          roundtrip.minute == minute,
          roundtrip.second == second else { return nil }
    return date
  }

  // MARK: - Bounded DER reader

  /// One definite-length TLV reader over a byte range. Indefinite lengths, non-minimal long-form
  /// lengths, length-of-length > 4 and every out-of-bounds read are refused.
  private struct DERRange {
    let bytes: [UInt8]
    private(set) var position: Int
    let end: Int

    init(bytes: [UInt8], start: Int, end: Int) {
      self.bytes = bytes
      self.position = start
      self.end = end
    }

    var isAtEnd: Bool { position == end }

    func peekTag() -> UInt8? {
      position < end ? bytes[position] : nil
    }

    mutating func read(tag expectedTag: UInt8? = nil) -> Range<Int>? {
      guard position < end else { return nil }
      let tag = bytes[position]
      if let expectedTag, tag != expectedTag { return nil }
      guard position + 1 < end else { return nil }

      let firstLength = bytes[position + 1]
      let contentLength: Int
      let headerLength: Int
      if firstLength < 0x80 {
        contentLength = Int(firstLength)
        headerLength = 2
      } else {
        let count = Int(firstLength & 0x7F)
        guard count >= 1, count <= 4, position + 2 + count <= end else { return nil }
        // DER requires the shortest possible long-form encoding.
        guard bytes[position + 2] != 0 else { return nil }
        var value = 0
        for offset in 0..<count {
          value = (value << 8) | Int(bytes[position + 2 + offset])
        }
        guard value >= 128 else { return nil }
        contentLength = value
        headerLength = 2 + count
      }

      let contentStart = position + headerLength
      guard contentStart <= end, contentLength <= end - contentStart else { return nil }
      let content = contentStart..<(contentStart + contentLength)
      position = content.upperBound
      return content
    }
  }
}
