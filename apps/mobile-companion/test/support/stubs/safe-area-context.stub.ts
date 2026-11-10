// Test-only stub of `react-native-safe-area-context`.
export function SafeAreaProvider({ children }: { children?: unknown }): unknown {
  return children;
}
export function useSafeAreaInsets() {
  return { top: 0, bottom: 0, left: 0, right: 0 };
}
