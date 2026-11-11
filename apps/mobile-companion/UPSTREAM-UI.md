# Upstream UI attribution

The screens under `app/` and the theme in `src/ui/` are a **port of the Clarklevis "Whaleness" frontend**
to React Native + Expo. Kotlin (Compose) and Swift (SwiftUI) cannot be copied verbatim into React Native,
so what was reproduced is the layout, visual language, interaction flow and copy structure, screen by
screen, read from their source.

| | |
|---|---|
| **Repository** | https://github.com/Clarklevis1995/dsh-mobile |
| **Product name** | Whaleness (DeepSeek Harness mobile client) |
| **Commit** | `3ec49d69f65c873db113ac8fc061df2c74154b29` (2026-11-08) |
| **Licence** | MIT — Copyright (c) 2026 Chaofan Li |
| **Author** | Chaofan Li (Clarklevis1995) |

## Ported files

Each ported file carries a one-line header naming its source path:

| Our file | Upstream source |
|---|---|
| `src/ui/theme.ts` | `androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshTheme.kt`, `SettingsTypography.kt`, `Design/design-spec.md` |
| `src/ui/components/ui.tsx` | `ui/DshTheme.kt` (`StatusIndicatorDot`), `ui/DshGlassButton.kt`, `ui/DshProductApp.kt` (cards), `ui/DshSwitch.kt` |
| `app/_layout.tsx` | `ui/DshTheme.kt` (themed window chrome), `ui/DshProductApp.kt` (navigation root) |
| `app/(tabs)/_layout.tsx` | `ui/DshProductApp.kt` (bottom navigation: Workspace / Conversations / Settings) |
| `app/(tabs)/index.tsx` | `ui/DshProductApp.kt` (workspace home: hero, recent sessions) |
| `app/(tabs)/conversations.tsx` | `ui/WorkspaceSessionSections.kt`, `ui/SessionStatusUi.kt` |
| `app/(tabs)/settings.tsx` | `ui/SettingsScreen.kt`, `ui/SettingsTypography.kt`, `ui/FontSizeSettingsScreen.kt` |

Also consulted, not yet ported: `GatewayAuthenticationUi.kt`, `GatewaySwitcherUi.kt`,
`ConversationScreen.kt`, `DshMarkdownText.kt`, `HumanQuestionCard.kt`, `DshMenu*.kt`.

## Assets

**No upstream binary assets have been copied yet.** `assets/upstream/` does not exist for P1: the
icons in the ported screens are Android VectorDrawables (XML), which React Native cannot render without
a new SVG dependency (spec 011: no new dependency without the lead's approval). The bottom tab bar
therefore uses label-led destinations with a filled active pill instead of their icon set. If/when an
icon dependency is approved, the icons go in `assets/upstream/` with this same attribution.

## Deliberate deviations

- **No Liquid Glass blur.** Upstream renders background blur/refraction for the tab bar, composer and
  cards; React Native's `expo-blur` is a new dependency, so P1 approximates it with a translucent fill
  plus border highlight and a soft shadow (`colors.glass`, `colors.glassHighlight`, `elevation()`).
- **No icons** (see above).
- **Omitted controls.** Clarklevis renders a workspace selector, a "New session" action, and many
  settings rows whose operations our gateway keeps admin-only (never served to a device token). Those
  are omitted in P1 rather than rendered dead — see `specs/011-companion-ui-redesign/spec.md` P2.
- **Copy.** Their Chinese strings inform meaning only; every shipped string is written for our `en` and
  `vi` tables.

## Licence

```text
MIT License

Copyright (c) 2026 Chaofan Li

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
