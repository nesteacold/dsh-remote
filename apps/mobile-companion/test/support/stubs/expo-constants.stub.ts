// Test-only stubs for the remaining Expo / UI modules the app imports. They exist so the app
// controller and screens can be imported in Node; behaviour that matters to the tests lives in
// `expo-secure-store.stub.ts` and `expo-local-authentication.stub.ts`.

export default {
  expoConfig: { version: '0.1.0' },
  executionEnvironment: 'bare',
};
