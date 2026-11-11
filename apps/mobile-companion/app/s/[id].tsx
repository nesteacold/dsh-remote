// A025 — deep-link landing route (`dshcompanion://s/<sessionId>`).
//
// Expo Router resolves an external URL against the file routes, so the link's path has to exist
// or its "Unmatched Route" screen wins and the app never runs (measured on the emulator: an
// `am start -d dshcompanion://s/sess-gamma` showed that screen). Both documented forms —
// `dshcompanion://s/<id>` and `dshcompanion:///s/<id>` — arrive as the path `s/<id>` because
// expo-router's native fork joins the URL host with the pathname (`fromDeepLink` in
// expo-router/build/fork/extractPathFromURL.js), so one file route covers both.
//
// This route only re-points the URL at the session screen. The root layout's `Linking` listener
// and `controller.handleDeepLink` stay the source of truth for opening the session and focusing an
// approval card, so nothing is parsed, fetched or connected here — and a card focus is not
// forwarded as `?a=` for the same reason. The route renders inside the gate's `<Stack>`, i.e. only
// after unlock, so a cold start through this URL still shows the unlock screen first.

import { Redirect, useLocalSearchParams } from 'expo-router';

export default function SessionDeepLinkRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  // expo-router already decoded the matched segment once, so it is re-encoded to stay a single
  // path segment for the session screen (which decodes it again).
  const id = typeof params.id === 'string' ? params.id : '';
  if (id.trim() === '') return <Redirect href="/" />;
  return <Redirect href={`/session/${encodeURIComponent(id)}`} />;
}
