// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/
// SettingsScreen.kt + SettingsTypography.kt + FontSizeSettingsScreen.kt (grouped rows, 17/22 item
// type, inset dividers) (MIT).
//
// Spec 011 P1-A item 6 — ONLY rows that work today. Clarklevis's Settings has dozens of entries
// (tailscale tunnel, plugins, storage, logs, appearance, about, ...); every one whose operation the
// companion cannot call yet is omitted rather than rendered dead (spec: "no button without
// something behind it"). Omitted in P1 and listed in the spec's P2 table:
//   theme override (needs a light/dark preference, theme follows the system today),
//   language switch (the locale feeds AppController's lifecycle; changing it at runtime is a
//   controller change, not a UI change — P2), storage/logs/plugins/tailscale/about.

import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useApp } from '../_layout';
import { Card, Divider, Screen, SectionLabel, StatusDot } from '../../src/ui/components/ui';
import { FONT_SCALES, space, useTheme } from '../../src/ui/theme';

export default function SettingsScreen() {
  const { controller, snapshot, tr } = useApp();
  const router = useRouter();
  const { colors, type, settingsType, radius, fontScale, setFontScale } = useTheme();
  const [busy, setBusy] = useState(false);

  const host = snapshot.activeHost;

  const forget = (): void => {
    Alert.alert(tr('sessions.forget'), tr('sessions.forgetConfirm'), [
      { text: tr('common.cancel'), style: 'cancel' },
      {
        text: tr('sessions.forget'),
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          void controller.forget().finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <Screen scroll testID="settings-screen">
      <Text style={[type.title, { color: colors.text, paddingHorizontal: space.xl, paddingTop: space.md }]}>
        {tr('settings.title')}
      </Text>

      <View style={styles.group}>
        <SectionLabel style={{ paddingHorizontal: space.xl }}>{tr('settings.computer')}</SectionLabel>
        {host === null ? (
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
            <Card>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('settings.pairAnother')}
                onPress={() => router.push('/pair')}
                style={styles.row}
              >
                <Text style={[settingsType.item, { color: colors.accent }]}>{tr('settings.pairAnother')}</Text>
              </Pressable>
            </Card>
          </View>
        ) : (
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
            <Card>
              <View style={styles.row}>
                <StatusDot kind={snapshot.banner === 'none' && snapshot.reconnect === null ? 'running' : 'idle'} />
                <View style={{ flex: 1 }}>
                  <Text style={[settingsType.item, { color: colors.text }]} numberOfLines={1}>
                    {host.name}
                  </Text>
                  <Text style={[settingsType.description, { color: colors.textMuted }]} numberOfLines={1}>
                    {host.publicUrl}
                  </Text>
                </View>
              </View>
              <Divider inset={0} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('settings.pairAnother')}
                onPress={() => router.push('/pair')}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Text style={[settingsType.item, { color: colors.accent }]}>{tr('settings.pairAnother')}</Text>
              </Pressable>
              <Divider inset={0} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('sessions.forget')}
                disabled={busy}
                onPress={forget}
                style={({ pressed }) => [styles.row, (pressed || busy) && styles.pressed]}
              >
                <Text style={[settingsType.item, { color: colors.danger }]}>{tr('sessions.forget')}</Text>
              </Pressable>
            </Card>
          </View>
        )}
      </View>

      <View style={styles.group}>
        <SectionLabel style={{ paddingHorizontal: space.xl }}>{tr('settings.fontSize')}</SectionLabel>
        <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
          <Card>
            <View style={styles.row}>
              {FONT_SCALES.map((scale) => {
                const active = Math.abs(fontScale - scale) < 0.001;
                return (
                  <Pressable
                    key={scale}
                    accessibilityRole="button"
                    accessibilityLabel={`${Math.round(scale * 100)}%`}
                    accessibilityState={{ selected: active }}
                    onPress={() => setFontScale(scale)}
                    style={[
                      styles.scaleChip,
                      { borderColor: colors.border, borderRadius: radius.sm, backgroundColor: active ? colors.accent : 'transparent' },
                    ]}
                  >
                    <Text style={[settingsType.item, { color: active ? colors.onAccent : colors.text }]}>
                      {Math.round(scale * 100)}%
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[settingsType.description, { color: colors.textFaint, paddingHorizontal: space.lg, paddingBottom: space.sm }]}>
              {tr('settings.fontSizeHint')}
            </Text>
          </Card>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { paddingTop: space.xxl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44, paddingVertical: space.sm },
  pressed: { opacity: 0.7 },
  scaleChip: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 2 },
});
