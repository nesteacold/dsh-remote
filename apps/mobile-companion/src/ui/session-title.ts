// Session display title — ONE helper for every place a session name is shown.
//
// Device defect: the header of a just-created session read
// `session-de1cb815-5a53-4dcb-8cd8-b64e53773df4`. A brand-new session genuinely has no Host title
// yet, and the wire id is not a name — it is a coordinate. Every surface (conversation header, recent
// rows on the workspace tab, conversation rows) now goes through this helper, so:
//   * a real Host title is shown the moment it exists (nothing is cached or invented);
//   * with no title, a human, localized label is shown instead, plus when it was created;
//   * the id is never rendered as content (it stays reachable via the route/testID, not as text).

import { relativeTime, type Locale, type MessageKey } from '../../i18n';

/** Interpolator the screens already have (`useApp().tr`). */
type Tr = (key: MessageKey, params?: Record<string, string | number>) => string;

/** True when the Host has not reported a usable title for this session yet. */
export function sessionTitleMissing(title: string | undefined | null): boolean {
  return title === undefined || title === null || title.trim() === '';
}

/**
 * What the user sees as the session's name.
 *
 * `updatedAt` is used as the creation-time proxy: for a session with no title it is the only timestamp
 * the wire gives us, and it is what the row already sorts by.
 */
export function sessionDisplayTitle(
  session: { readonly title?: string; readonly updatedAt?: number },
  tr: Tr,
  locale: Locale,
  now: number = Date.now(),
): string {
  const title = session.title?.trim();
  if (title !== undefined && title !== '') return title;
  const updatedAt = session.updatedAt ?? 0;
  if (updatedAt <= 0 || updatedAt > now) return tr('session.untitled');
  return tr('session.untitledAgo', { when: relativeTime(locale, now - updatedAt) });
}
