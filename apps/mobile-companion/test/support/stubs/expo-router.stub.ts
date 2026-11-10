// Test-only stub of `expo-router`.
export const Stack = { Screen: 'Screen' };
export function useRouter() {
  return { push: () => undefined, replace: () => undefined, back: () => undefined };
}
export function useNavigation() {
  return { setOptions: () => undefined };
}
export function useLocalSearchParams() {
  return {};
}
export default { push: () => undefined };
