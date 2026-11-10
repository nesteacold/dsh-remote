// Test-only stub of `react-native`. Only what `src/app-state.ts` touches: AppState,
// Platform.OS. No rendering happens in Node tests.

type Listener = (state: string) => void;

const listeners = new Set<Listener>();

export const AppState = {
  currentState: 'active' as string,
  addEventListener(_event: 'change', listener: Listener) {
    listeners.add(listener);
    return {
      remove() {
        listeners.delete(listener);
      },
    };
  },
};

/** Test helper: move the app between `active` and `background`. */
export function emitAppState(state: string): void {
  AppState.currentState = state;
  for (const listener of [...listeners]) listener(state);
}

export function resetAppState(state = 'active'): void {
  AppState.currentState = state;
  listeners.clear();
}

export const Platform = {
  OS: 'android' as const,
  select<T>(options: Record<string, T>): T | undefined {
    return options.android ?? options.default;
  },
};

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
  hairlineWidth: 1,
  absoluteFill: {},
};

export const View = 'View';
export const Text = 'Text';
export const TextInput = 'TextInput';
export const TouchableOpacity = 'TouchableOpacity';
export const ScrollView = 'ScrollView';
export const ActivityIndicator = 'ActivityIndicator';
export const RefreshControl = 'RefreshControl';
export const KeyboardAvoidingView = 'KeyboardAvoidingView';
export const Alert = { alert: () => undefined };
export const useColorScheme = () => 'light';
export const NativeModules = {};
