// Runtime facts the core needs (contract §3.6 `client-hello.appVersion` / `platform`).
// Kept out of `src/core` so the core stays free of expo/react-native imports.

import { Platform } from 'react-native';
import Constants from 'expo-constants';

export function platformName(): 'ios' | 'android' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

/** App version from the Expo manifest (`app.json` `expo.version`). */
export function appVersion(): string {
  const version = Constants.expoConfig?.version;
  return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
}

/** True when running inside Expo Go (no custom native modules such as pinned-ws). */
export function isExpoGo(): boolean {
  return Constants.executionEnvironment === 'storeClient';
}
