// A025 — the id-less shape of the same deep-link path (`dshcompanion://s`, `dshcompanion:///s`).
//
// A dynamic `:id` segment requires at least one character, so `app/s/[id].tsx` cannot catch a link
// without an id and Expo Router would show "Unmatched Route" instead. `parseSessionDeepLink`
// rejects these links too, so there is no session to open: land on the list.

import { Redirect } from 'expo-router';

export default function SessionDeepLinkWithoutId() {
  return <Redirect href="/" />;
}
