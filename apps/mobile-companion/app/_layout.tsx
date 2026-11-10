// A020 — unlock gate root layout.
//
// The whole app sits behind a biometric / device-passcode gate: the credential is only read
// from the secure store after `unlock()` (FR-003, US1 §3). The gate also handles the
// "no screen lock configured" case explicitly instead of silently skipping protection, and
// routes a notification tap (deep link) to the right session/card after unlock (US6 §2).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppController, type AppStateSnapshot } from '../src/app-state';
import { parseSessionDeepLink, type UpdateRequired } from '../src/core';
import { StartupSequence } from '../src/core/startup';
import { UnlockAttempts } from '../src/core/unlock-attempt';
import { authenticate, initialNotificationUrl, unlockCapability } from '../src/platform';
import { detectLocale, t, type Interpolate, type Locale } from '../i18n';

type GateStatus = 'checking' | 'locked' | 'unlocked' | 'unavailable';

export default function RootLayout() {
  const locale = useMemo<Locale>(() => detectLocale(localeTag()), []);
  const tr = useCallback<Interpolate>((key, params) => t(locale, key, params), [locale]);
  const controller = useMemo(() => new AppController({ locale: () => locale }), [locale]);
  const [snapshot, setSnapshot] = useState<AppStateSnapshot>(() => controller.snapshot());
  const [gate, setGate] = useState<GateStatus>('checking');
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const router = useRouter();
  const unlocking = useRef(false);
  /**
   * A020/M5 — identity of the unlock prompt in flight. Backgrounding, a newer prompt and an
   * unmount invalidate it (see `UnlockAttempts`), so a platform prompt that answers late can
   * neither re-open the gate nor connect the socket while the app is in the background.
   */
  const attemptsRef = useRef<UnlockAttempts | null>(null);
  if (attemptsRef.current === null) attemptsRef.current = new UnlockAttempts();
  const attempts = attemptsRef.current;
  /**
   * Cold start: `controller.start()` loads the stored host asynchronously and `unlock()` only
   * connects a host that is already installed, so an unlock that races the start reads the
   * credential with `host === null` and connects nothing (the app looks unlocked and stays
   * offline). Both paths await this one attempt; a failed start stays behind the gate and is
   * retryable instead of becoming an unhandled rejection.
   */
  const startup = useMemo(
    () => new StartupSequence({ start: () => controller.start(), reset: () => controller.stop() }),
    [controller],
  );

  useEffect(() => {
    // A020/M5: an unlock prompt that outlives the layout must not touch state or the controller.
    attempts.setMounted(true);
    return () => attempts.setMounted(false);
  }, [attempts]);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    // One attempt, shared with the unlock path below: the gate may run before the host list is
    // loaded. `ensure()` records a failure (it never rejects); the unlock path reports it.
    void startup.ensure();
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller, startup]);

  const attemptUnlock = useCallback(
    async (auto: boolean) => {
      if (unlocking.current) return;
      unlocking.current = true;
      /** This prompt's identity; every post-await step is a no-op once it is superseded. */
      const attempt = attempts.begin();
      try {
        // A020/M5: never unlock before the stored host is loaded (`start()`), or the credential
        // is read with no active host and the app stays unlocked but unconnected. The same guard
        // covers the trip through the start: a background lock or unmount makes this attempt
        // stale, so its answer can neither open the gate nor connect.
        const started = await startup.ensure();
        if (!attempts.isCurrent(attempt)) return;
        if (!started) {
          // Startup failed (secure store / notification setup). Stay behind the gate and let the
          // button retry: the next `ensure()` runs `stop()` + `start()` again.
          setGate('locked');
          setGateMessage(tr('unlock.failed'));
          return;
        }
        const capability = await unlockCapability();
        if (!attempts.isCurrent(attempt)) return;
        if (capability === 'unavailable') {
          setGate('unavailable');
          setGateMessage(tr('unlock.unavailable'));
          return;
        }
        const result = await authenticate(tr('unlock.prompt'));
        // A020/M5: the platform prompt outlives a background lock, a newer attempt or an
        // unmount, so its answer is only usable while this attempt is still current. Acting on
        // a stale success would open the gate and read the credential in the background.
        if (!attempts.isCurrent(attempt)) return;
        if (!result.ok) {
          setGate('locked');
          setGateMessage(
            result.reason === 'user-cancel'
              ? tr('unlock.cancelled')
              : result.reason === 'locked-out'
                ? tr('unlock.lockedOut')
                : result.reason === 'unavailable'
                  ? tr('unlock.unavailable')
                  : tr('unlock.failed'),
          );
          return;
        }
        setGateMessage(result.capability === 'passcode' ? tr('unlock.passcodeOnly') : null);
        setGate('unlocked');
        await controller.unlock();
        // `unlock()` itself awaits the secure-store read in the controller: re-check before
        // routing, so a lock during that read cannot navigate a backgrounded app.
        if (!attempts.isCurrent(attempt)) return;
        const pending = controller.takeDeepLink() ?? (await initialNotificationUrl().then(parseLink));
        if (pending !== null && attempts.isCurrent(attempt)) {
          router.push(`/session/${encodeURIComponent(pending.sessionId)}${pending.approvalId === null ? '' : `?a=${encodeURIComponent(pending.approvalId)}`}`);
        }
      } finally {
        unlocking.current = false;
      }
    },
    [attempts, controller, router, startup, tr],
  );

  // Re-lock whenever the app leaves the foreground (the credential must not stay usable).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      // A020/M5: only `background` is a credential boundary. Reporting `inactive` would cancel
      // the attempt while the system biometric/passcode sheet is open (iOS reports it there).
      if (next === 'active') {
        attempts.setForeground(true);
        return;
      }
      if (next !== 'background') return;
      attempts.setForeground(false);
      // M5: locking is a credential boundary, not only a visual one — the controller stops
      // the reconnect loop and closes the socket (its token-bearing closure is released).
      controller.lock();
      // 'checking' is included: an auto-prompt abandoned by this lock must not leave the gate
      // spinning — a superseded attempt no longer sets 'locked' itself.
      setGate((current) => (current === 'unlocked' || current === 'checking' ? 'locked' : current));
    });
    return () => subscription.remove();
  }, [attempts, controller]);

  useEffect(() => {
    if (gate === 'checking') void attemptUnlock(true);
  }, [gate, attemptUnlock]);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', (event) => {
      void controller.handleDeepLink(event.url);
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => {
    controller.setNotificationCopy({
      title: tr('notice.notification.title'),
      body: (toolName) => tr('notice.notification.body', { tool: toolName }),
    });
  }, [controller, tr]);

  const locked = gate === 'checking' || gate === 'locked' || gate === 'unavailable';
  const updateRequired = snapshot.updateRequired;

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {locked ? (
        <View style={styles.gate}>
          <Text style={styles.title}>{tr('unlock.title')}</Text>
          <Text style={styles.subtitle}>{tr('unlock.subtitle')}</Text>
          {gateMessage !== null ? <Text style={styles.message}>{gateMessage}</Text> : null}
          {gate === 'checking' ? null : (
            <TouchableOpacity
              style={styles.button}
              accessibilityRole="button"
              onPress={() => {
                setGate('locked');
                setGateMessage(null);
                void attemptUnlock(false);
              }}
            >
              <Text style={styles.buttonText}>{gate === 'unavailable' ? tr('common.ok') : tr('unlock.button')}</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <AppProvider controller={controller} snapshot={snapshot} tr={tr} locale={locale}>
          <Stack screenOptions={{ headerShown: true }}>
            <Stack.Screen name="index" options={{ title: tr('unlock.title') }} />
            <Stack.Screen name="pair" options={{ title: tr('pair.title') }} />
            <Stack.Screen name="session/[id]" options={{ title: tr('common.host') }} />
          </Stack>
          {updateRequired !== null ? (
            // N7: a protocol mismatch is terminal for this connection, so it gets an actionable
            // screen (what to update, retry, and a way to pair a different computer) instead of a
            // silent failure or a stale session list. It overlays the stack so "pair another
            // computer" can still navigate.
            <UpdateRequiredScreen
              update={updateRequired}
              tr={tr}
              onRetry={() => void controller.retryConnection()}
              onPairAnother={() => {
                controller.dismissUpdateRequired();
                router.replace('/pair');
              }}
            />
          ) : null}
        </AppProvider>
      )}
    </SafeAreaProvider>
  );
}

/** N7 — the app and the host cannot talk until one side updates: say which, and offer a retry. */
function UpdateRequiredScreen(props: {
  update: UpdateRequired;
  tr: Interpolate;
  onRetry: () => void;
  onPairAnother: () => void;
}) {
  const { update, tr, onRetry, onPairAnother } = props;
  const appSide = update.side === 'app';
  const version = update.minClientVersion ?? update.hostCompanionProtocol;
  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <View style={styles.gate}>
        <Text style={styles.title}>{tr(appSide ? 'update.appTitle' : 'update.hostTitle')}</Text>
        <Text style={styles.subtitle}>{tr(appSide ? 'update.appBody' : 'update.hostBody')}</Text>
        {version === undefined ? null : <Text style={styles.message}>{tr('update.details', { version })}</Text>}
        <TouchableOpacity style={styles.button} accessibilityRole="button" onPress={onRetry}>
          <Text style={styles.buttonText}>{tr('update.retry')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondary} accessibilityRole="button" onPress={onPairAnother}>
          <Text style={styles.secondaryText}>{tr('update.pairAnother')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function localeTag(): string | null {
  // Hermes' Intl is complete in RN 0.88; guard anyway so a missing Intl never breaks the gate.
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? null;
  } catch {
    return null;
  }
}

function parseLink(url: string | null): { sessionId: string; approvalId: string | null } | null {
  return url === null ? null : parseSessionDeepLink(url);
}

// ---------------------------------------------------------------------------
// Context handed to the screens
// ---------------------------------------------------------------------------

interface AppContextValue {
  controller: AppController;
  snapshot: AppStateSnapshot;
  tr: Interpolate;
  locale: Locale;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ controller, snapshot, tr, locale, children }: AppContextValue & { children: ReactNode }) {
  return <AppContext.Provider value={{ controller, snapshot, tr, locale }}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp() outside the unlock gate');
  return value;
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#fff' },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  title: { fontSize: 26, fontWeight: '700' },
  subtitle: { fontSize: 15, opacity: 0.7, textAlign: 'center' },
  message: { fontSize: 14, color: '#b45309', textAlign: 'center', marginTop: 8 },
  button: { marginTop: 16, backgroundColor: '#2563eb', paddingHorizontal: 28, paddingVertical: 14, borderRadius: 12 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondary: { marginTop: 4, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: '#e2e8f0' },
  secondaryText: { fontSize: 15, fontWeight: '600' },
});
