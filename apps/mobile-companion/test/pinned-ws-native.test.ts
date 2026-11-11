// A030 — static guards for the NATIVE sources of `modules/pinned-ws` (Kotlin + Swift).
//
// Neither native toolchain is available on this machine (no Xcode/swiftc, no Android SDK/kotlinc,
// and the app has no generated `android/` or `ios/` project), so the Kotlin and Swift code cannot
// be compiled here — `npm test` runs on Node only. These checks are therefore the strongest
// verification that is actually executable in this repo. They cover two kinds of defect that no
// other JS test can see:
//
//   1. build-breakers a compiler would catch: invalid JSON in the module manifest that the
//      podspec `JSON.parse`s, and the Swift/Kotlin typing mistakes found in review
//      (`Result<URL, PinnedWsUrlError>` with a non-`Error` failure type, `UInt16` into
//      `CloseCode(rawValue:)` plus an optional passed to the non-optional `cancel(with:)`,
//      and `val message` hiding `Exception.message` without `override`);
//   2. the security invariants the JS transport relies on: `wss://` only, the leaf SHA-256 pin as
//      the ONLY trust anchor, the pin compared inside the handshake before the credential is
//      used, and no CA/cleartext fallback on either platform.
//
// Each assertion is a small, load-bearing literal per platform — not a parser. A rewrite that
// keeps the invariant should keep these statements; if it does not, failing here is the prompt to
// re-justify the change in review rather than a sign the check is wrong.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PINNED_WS_ERROR } from '../modules/pinned-ws/src/errors';
import { PINNED_WS_EVENT_NAMES } from '../modules/pinned-ws/src/events';

// `--import tsx` transpiles these files to CommonJS, so `__dirname` is this folder.
const APP_ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(APP_ROOT, 'modules', 'pinned-ws');
const JAVA_DIR = path.join(MODULE_DIR, 'android', 'src', 'main', 'java', 'expo', 'modules', 'pinnedws');

const FILES = {
  packageJson: path.join(MODULE_DIR, 'package.json'),
  moduleConfig: path.join(MODULE_DIR, 'expo-module.config.json'),
  podspec: path.join(MODULE_DIR, 'ios', 'PinnedWs.podspec'),
  swiftConnection: path.join(MODULE_DIR, 'ios', 'PinnedWsConnection.swift'),
  swiftErrors: path.join(MODULE_DIR, 'ios', 'PinnedWsErrors.swift'),
  swiftModule: path.join(MODULE_DIR, 'ios', 'PinnedWsModule.swift'),
  swiftValidity: path.join(MODULE_DIR, 'ios', 'PinnedWsValidity.swift'),
  androidBuildGradle: path.join(MODULE_DIR, 'android', 'build.gradle'),
  reactNativeLibs: path.join(APP_ROOT, 'node_modules', 'react-native', 'gradle', 'libs.versions.toml'),
  kotlinConnection: path.join(JAVA_DIR, 'PinnedWsConnection.kt'),
  kotlinErrors: path.join(JAVA_DIR, 'PinnedWsErrors.kt'),
  kotlinModule: path.join(JAVA_DIR, 'PinnedWsModule.kt'),
  kotlinRegistry: path.join(JAVA_DIR, 'PinnedWsRegistry.kt'),
  kotlinTrust: path.join(JAVA_DIR, 'PinnedTrustManager.kt'),
} as const;

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('pinned-ws native sources (build-shape regressions)', () => {
  it('every JSON manifest parses, so the podspec JSON.parse does not fail', () => {
    // Regression: a trailing comma after the `files` array made `JSON.parse` in
    // ios/PinnedWs.podspec raise, which fails pod install for the whole app.
    for (const file of [FILES.packageJson, FILES.moduleConfig]) {
      assert.doesNotThrow(() => JSON.parse(read(file)), `${path.basename(file)} must be valid JSON`);
    }
    const pkg = JSON.parse(read(FILES.packageJson)) as { name?: unknown; main?: unknown };
    assert.equal(pkg.name, '@dsh-ext/pinned-ws');
    // The podspec reads the version/description straight out of that file.
    const podspec = read(FILES.podspec);
    assert.match(podspec, /JSON\.parse\(File\.read\(/);
    assert.match(podspec, /package\.json/);
    // The Swift sources `import ExpoModulesCore`, so the pod must depend on it.
    assert.match(podspec, /s\.dependency 'ExpoModulesCore'/);
  });

  it('iOS: PinnedWsUrlError is a Swift Error, so Result<URL, PinnedWsUrlError> is well-formed', () => {
    const swift = read(FILES.swiftConnection);
    // Regression: `enum PinnedWsUrlError { case scheme ... }` without `: Error` does not satisfy
    // `Result`'s `Failure: Error` constraint.
    assert.match(swift, /enum PinnedWsUrlError: Error \{/);
    assert.match(swift, /-> Result<URL, PinnedWsUrlError>/);
  });

  it('iOS: close() maps the caller code onto URLSessionWebSocketTask.CloseCode without an optional', () => {
    const swift = read(FILES.swiftConnection);
    // Regression: `UInt16(truncatingIfNeeded:)` was passed to `CloseCode(rawValue:)` (Int raw
    // value), and the failable initializer's `CloseCode?` went into the non-optional
    // `cancel(with:reason:)`.
    assert.doesNotMatch(swift, /UInt16\(truncatingIfNeeded/);
    assert.match(swift, /let rawCode = min\(max\(code, 1000\), 4999\)/);
    assert.match(swift, /URLSessionWebSocketTask\.CloseCode\(rawValue: rawCode\) \?\? \.normalClosure/);
    assert.match(swift, /task\.cancel\(with: closeCode, reason: /);
  });

  it('Android: PinnedWsRefusal overrides Throwable.message instead of hiding it', () => {
    const kotlin = read(FILES.kotlinConnection);
    // Regression: `val message: String` hid `Exception.message` (Kotlin: "'message' hides member
    // of supertype 'Exception' and needs 'override' modifier"). The declared type is non-null so
    // `refusal.message` can be handed to `PinnedWsError(message: String)` unchanged.
    assert.match(
      kotlin,
      /internal class PinnedWsRefusal\(val code: String, override val message: String\) : Exception\(message\)/,
    );
  });

  it('Android: OkHttp is an explicit 4.9.2 compileOnly dependency matching installed RN', () => {
    const gradle = read(FILES.androidBuildGradle);
    // Regression: a versionless `compileOnly "com.squareup.okhttp3:okhttp"` leaves the module's
    // compile classpath dependent on app-level dependency order, and the old afterEvaluate
    // check resolved too late to make it resolvable. The version must be explicit and match the
    // OkHttp that React Native 0.88.1 brings at runtime.
    const dependency = /com\.squareup\.okhttp3:okhttp:([0-9]+\.[0-9]+\.[0-9]+)/.exec(gradle);
    assert.ok(dependency, 'build.gradle must declare an explicit OkHttp version');
    const rnToml = read(FILES.reactNativeLibs);
    const rnVersion = /^okhttp\s*=\s*"([^"]+)"/m.exec(rnToml);
    assert.ok(rnVersion, 'installed react-native must declare its OkHttp version');
    assert.equal(dependency[1], rnVersion[1], 'pinned-ws must compile against the installed RN OkHttp');
    assert.equal(dependency[1], '4.9.2');
    assert.match(gradle, /compileOnly\s+["']com\.squareup\.okhttp3:okhttp:4\.9\.2["']/);
    // The ineffective afterEvaluate/runtimeClasspath verification is gone.
    assert.doesNotMatch(gradle, /afterEvaluate|runtimeClasspath|resolvedConfiguration/);
    assert.doesNotMatch(gradle, /compileOnly\s+["']com\.squareup\.okhttp3:okhttp["']/);
  });
});

describe('pinned-ws native sources (security invariants)', () => {
  it('both platforms refuse anything but wss:// before any I/O', () => {
    assert.match(read(FILES.swiftConnection), /guard trimmed\.lowercased\(\)\.hasPrefix\("wss:\/\/"\)/);
    assert.match(read(FILES.kotlinConnection), /if \(!trimmed\.startsWith\("wss:\/\/", ignoreCase = true\)\)/);
  });

  it('iOS: both challenge routes run the one pin check (no CA fallback, no task-route blanket cancel)', () => {
    const swift = read(FILES.swiftConnection);
    // Regression: the task-level hook used to answer every `NSURLAuthenticationMethodServerTrust`
    // challenge with `.cancelAuthenticationChallenge`, on the assumption that the session-level
    // hook would handle server trust. A `URLSessionWebSocketTask` sends its TLS handshake to the
    // task-level hook, so that shape cancelled correctly pinned peers and left the pin
    // unreachable for real sockets. Both hooks must now delegate to the same checker.
    const taskHook = swift.indexOf('task: URLSessionTask,');
    const taskCall = swift.indexOf('handleServerTrustChallenge(task: task', taskHook);
    const sessionHook = swift.indexOf('didReceive challenge: URLAuthenticationChallenge', taskHook);
    const sessionCall = swift.indexOf('handleServerTrustChallenge(task: nil', sessionHook);
    const sharedDoc = swift.indexOf('The one pin check, shared by both delegate routes.');
    const shared = swift.indexOf('private func handleServerTrustChallenge(');
    assert.ok(taskHook > 0, 'the task-level challenge hook is gone');
    assert.ok(sessionHook > taskHook, 'the session-level challenge hook is gone');
    assert.ok(taskCall > taskHook, 'the task-level hook must call the shared pin/validity check');
    assert.ok(sessionCall > sessionHook, 'the session-level hook must call the shared pin/validity check');
    assert.ok(shared > sessionCall, 'the shared pin/validity challenge handler is gone');

    // Neither route decides trust on its own: no blanket cancel, no default (CA) handling, no
    // credential. The wrapper's body is the delegation call and nothing else.
    const taskWrapper = swift.slice(taskHook, taskCall);
    const sessionWrapper = swift.slice(sessionHook, sessionCall);
    for (const [label, wrapper] of [
      ['task', taskWrapper],
      ['session', sessionWrapper],
    ] as const) {
      assert.doesNotMatch(wrapper, /\.cancelAuthenticationChallenge/, `the ${label}-level hook must not blanket-cancel`);
      assert.doesNotMatch(wrapper, /\.useCredential/);
    }
    // `.performDefaultHandling(…)` would be platform CA evaluation (or a credential lookup): the
    // pin is the only trust decision, so no call site may pass it.
    assert.doesNotMatch(swift, /\.performDefaultHandling\s*,/);
    assert.doesNotMatch(swift, /\.performDefaultHandling\s*\)/);

    // The shared checker: server trust only, pin compared in constant time, then the validity
    // window, and only then the credential. `sharedDoc` bounds the doc comment off the body.
    assert.ok(sharedDoc > 0 && sharedDoc < shared);
    const sharedBody = swift.slice(
      shared,
      swift.indexOf('func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError'),
    );
    assert.match(sharedBody, /authenticationMethod == NSURLAuthenticationMethodServerTrust/);
    assert.match(sharedBody, /let trust = challenge\.protectionSpace\.serverTrust/);
    assert.match(sharedBody, /\.cancelAuthenticationChallenge/);
    const pinCompare = sharedBody.indexOf('PinnedWsPin.constantTimeEquals(expected, observed)');
    const validity = sharedBody.indexOf('PinnedWsValidity.evaluate(leaf)');
    const useCredential = sharedBody.indexOf('.useCredential, URLCredential(trust: trust)');
    assert.ok(pinCompare > 0, 'the constant-time pin comparison is gone');
    assert.ok(validity > pinCompare, 'the validity window must be checked after the pin matches');
    assert.ok(useCredential > validity, 'the credential must not be used before the pin+validity check');
  });

  it('iOS: an expired or not-yet-valid pinned leaf is rejected before useCredential (A047)', () => {
    const swift = read(FILES.swiftConnection);
    const validity = read(FILES.swiftValidity);
    // SecCertificateCopyValues is macOS-only and must not appear in an iOS module.
    assert.doesNotMatch(swift + validity, /SecCertificateCopyValues/);
    // A self-signed leaf anchored to itself is not a certificate path; the window is read from
    // the DER instead of asking SecTrust to evaluate an anchor.
    assert.doesNotMatch(swift + validity, /SecTrustEvaluateWithError|SecTrustSetAnchorCertificates/);

    const pinCompare = swift.indexOf('PinnedWsPin.constantTimeEquals(expected, observed)');
    const validityCheck = swift.indexOf('PinnedWsValidity.evaluate(leaf)');
    const useCredential = swift.indexOf('.useCredential, URLCredential(trust: trust)');
    assert.ok(pinCompare > 0, 'the constant-time pin comparison is gone');
    assert.ok(validityCheck > pinCompare, 'the validity window must be checked after the pin matches');
    assert.ok(useCredential > validityCheck, 'the credential must not be used before the validity check');

    const rejection = swift.slice(validityCheck, useCredential);
    assert.match(rejection, /\.cancelAuthenticationChallenge/);
    assert.match(rejection, /pinRejected = true/);
    assert.match(rejection, /pinnedCertificateExpired/);
    assert.match(rejection, /pinnedCertificateNotYetValid/);

    // Strict bounded DER, not a substring/date scan: definite lengths, both RFC 5280 Time
    // tags, the UTCTime 1950/2049 pivot, and a Gregorian round-trip that rejects 20260230.
    assert.match(validity, /private static let maxCertificateBytes = 1 << 20/);
    assert.match(validity, /case 0x17:/);
    assert.match(validity, /case 0x18:/);
    // TBSCertificate order is serialNumber, signature, issuer, validity. Forgetting `issuer`
    // makes the parser read the issuer Name as Validity and reject every real certificate.
    const serial = validity.indexOf('// serialNumber');
    const issuer = validity.indexOf('// issuer Name');
    const validityField = validity.indexOf('let validityContent = tbs.read(tag: 0x30)');
    assert.ok(serial > 0, 'the serialNumber field is gone');
    assert.ok(issuer > serial, 'the issuer Name must be skipped before validity');
    assert.ok(validityField > issuer, 'validity must be read after the issuer Name');
    assert.match(validity, /year2 >= 50 \? 1900 \+ year2 : 2000 \+ year2/);
    assert.match(validity, /Calendar\(identifier: \.gregorian\)/);
    assert.match(validity, /roundtrip\.year == year/);
    assert.match(validity, /return \.malformed/);
    // No deployment-floor increase was needed for this parse.
    assert.match(read(FILES.podspec), /:ios => '16\.4'/);
  });

  it('iOS: didCompleteWithError captures task.response status and maps one terminal event', () => {
    const swift = read(FILES.swiftConnection);
    const complete = swift.indexOf(
      'func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError',
    );
    assert.ok(complete > 0, 'didCompleteWithError is required to see a refused upgrade status');
    const completeBody = swift.slice(complete);
    const capture = completeBody.indexOf('captureUpgradeStatus(from: task)');
    const handle = completeBody.indexOf('handleFailure(error)');
    assert.ok(capture > 0, 'didCompleteWithError must capture task.response');
    assert.ok(handle > capture, 'didCompleteWithError must map the failure after capturing the status');

    // The receive-failure path also reads task.response, so callback ordering cannot lose the
    // 401/403 status. Both paths re-enter the same idempotent mapper.
    const failure = swift.indexOf('private func handleFailure');
    const failureBody = swift.slice(failure, complete);
    assert.ok(failureBody.indexOf('captureUpgradeStatus(from: task)') > 0);
    assert.match(failureBody, /if finished \{\s*lock\.unlock\(\)\s*return\s*\}/);
    assert.match(swift, /if let status, status != 101/);
    assert.match(swift, /upgradeStatus = response\.statusCode/);
  });

  it('Android: the only trust manager is the leaf-pin check (no default trust store)', () => {
    const kotlin = read(FILES.kotlinConnection);
    assert.match(kotlin, /sslContext\.init\(null, arrayOf<X509TrustManager>\(trust\), SecureRandom\(\)\)/);
    assert.match(kotlin, /\.sslSocketFactory\(sslContext\.socketFactory, trust\)/);
    // No CA store may be introduced next to the pin.
    assert.doesNotMatch(kotlin, /TrustManagerFactory/);
    assert.doesNotMatch(kotlin, /KeyStore|load\(null\)/);
    // A mismatch throws inside the handshake instead of returning success.
    assert.match(read(FILES.kotlinTrust), /throw CertificateException\(PinnedWsMessages\.PIN_MISMATCH\)/);
    assert.match(read(FILES.kotlinTrust), /observedSha256Hex = observed/);
  });

  it('Android: a pin-matched expired/not-yet-valid leaf stays on the pin-failure path', () => {
    const trust = read(FILES.kotlinTrust);
    const connection = read(FILES.kotlinConnection);
    const pinCompare = trust.indexOf('constantTimeEquals(expectedSha256Hex, observed)');
    const validity = trust.indexOf('leaf.checkValidity()');
    assert.ok(pinCompare > 0, 'the constant-time pin comparison is gone');
    assert.ok(validity > pinCompare, 'validity must be checked only after the pin matches');
    assert.match(trust, /throw CertificateException\(PinnedWsMessages\.PINNED_CERTIFICATE_EXPIRED\)/);
    assert.match(trust, /throw CertificateException\(PinnedWsMessages\.PINNED_CERTIFICATE_NOT_YET_VALID\)/);
    const classify = connection.slice(
      connection.indexOf('private fun classify'),
      connection.indexOf('private fun failBeforeOpen'),
    );
    assert.match(classify, /PinnedWsMessages\.PINNED_CERTIFICATE_EXPIRED/);
    assert.match(classify, /PinnedWsMessages\.PINNED_CERTIFICATE_NOT_YET_VALID/);
    assert.match(classify, /PinnedWsErrors\.PIN_MISMATCH/);
  });

  it('the JS binding has no unpinned-WebSocket fallback', () => {
    for (const file of [path.join(MODULE_DIR, 'index.ts'), path.join(MODULE_DIR, 'src', 'PinnedWsModule.ts')]) {
      const source = read(file);
      assert.doesNotMatch(source, /new WebSocket\(/, `${path.basename(file)} must not open an unpinned socket`);
      assert.doesNotMatch(source, /globalThis\.WebSocket|global\.WebSocket/, `${path.basename(file)} must not open an unpinned socket`);
    }
  });
});

describe('pinned-ws native/JS contract parity', () => {
  it('both platforms use the JS error codes verbatim', () => {
    const swiftErrors = read(FILES.swiftErrors);
    const kotlinErrors = read(FILES.kotlinErrors);
    for (const code of Object.values(PINNED_WS_ERROR)) {
      assert.ok(swiftErrors.includes(`"${code}"`), `iOS is missing the error code ${code}`);
      assert.ok(kotlinErrors.includes(`"${code}"`), `Android is missing the error code ${code}`);
    }
  });

  it('both platforms emit the four JS event names verbatim', () => {
    const swiftErrors = read(FILES.swiftErrors);
    const kotlinRegistry = read(FILES.kotlinRegistry);
    for (const name of PINNED_WS_EVENT_NAMES) {
      assert.ok(swiftErrors.includes(`"${name}"`), `iOS is missing the event ${name}`);
      assert.ok(kotlinRegistry.includes(`"${name}"`), `Android is missing the event ${name}`);
    }
  });

  it('both platforms keep the module name and the three functions the adapter calls', () => {
    for (const file of [FILES.swiftModule, FILES.kotlinModule]) {
      const source = read(file);
      // `PINNED_WS_MODULE_NAME` in src/PinnedWsModule.ts.
      assert.match(source, /Name\("PinnedWs"\)/, `${path.basename(file)} must keep Name("PinnedWs")`);
      for (const fn of ['connect', 'send', 'close']) {
        assert.ok(source.includes(`"${fn}"`), `${path.basename(file)} must expose ${fn}()`);
      }
    }
  });

  it('close reasons stay within the RFC 6455 123-byte cap on both platforms', () => {
    assert.match(read(FILES.swiftErrors), /let PINNED_WS_MAX_REASON_BYTES = 123/);
    assert.match(read(FILES.swiftConnection), /reason\.prefix\(PINNED_WS_MAX_REASON_BYTES\)/);
    assert.match(read(FILES.kotlinConnection), /reason\.take\(MAX_REASON_LENGTH\)/);
    assert.match(read(FILES.kotlinConnection), /const val MAX_REASON_LENGTH = 123/);
  });
});
