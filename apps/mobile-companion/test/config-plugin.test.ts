// A031 — the `./plugins/withPinnedWsConfig` config plugin.
//
// A full `npx expo prebuild` cannot complete on this machine (it needs `@expo/cli` + network; see
// the report), so these tests drive the plugin the same two ways prebuild does:
//   * through its exported pure helpers — the exact functions its prebuild mods call — against a
//     stand-in native project;
//   * through the mods themselves (`config.mods.android.manifest` / `.dangerous`,
//     `config.mods.ios.xcodeproj`) that Expo's mod compiler runs, so the wiring is covered and
//     not just the helpers.
//
// They assert:
//   * the Android application points at `@xml/network_security_config` and gets
//     `android:usesCleartextTraffic="false"` AUTHORED BY THE PLUGIN when app.json leaves it unset
//     (Expo's app config has no `android.usesCleartextTraffic` field: expo-doctor / EAS reject it);
//   * any non-"false" value already on the manifest, and any `android.usesCleartextTraffic` in
//     app.json (unsafe `true`, or a stale `false`), is rejected at config time;
//   * the generated network-security-config is well-formed, trusts no CA, and permits no cleartext;
//   * an app.json that adds ATS exceptions is rejected (ATS stays at its secure default);
//   * `vi` + `en` `InfoPlist.strings` files contain camera / Face ID strings;
//   * those files are registered in `project.pbxproj` (A033) as an `InfoPlist.strings`
//     `PBXVariantGroup` in the app group, with one `<locale>.lproj/InfoPlist.strings` file
//     reference per locale and exactly one `Resources` build-phase entry, so Xcode actually
//     copies them into the bundle — against a realistic fixture project, idempotently (a second
//     prebuild changes nothing) and without duplicating a plain file-reference registration.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
// The plugin is CommonJS, exactly as Expo loads it from app.json's `plugins` list.
const plugin = require('../plugins/withPinnedWsConfig') as {
  withPinnedWsConfig: (config: Record<string, unknown>, props?: Record<string, unknown>) => Record<string, unknown>;
  assertNoCleartextOptIn: (config: Record<string, unknown>) => void;
  assertNoAtsOptIn: (config: Record<string, unknown>) => void;
  applyNetworkSecurityConfig: (manifest: ManifestLike) => ManifestLike;
  writeNetworkSecurityConfig: (projectRoot: string) => string;
  assertAtsDefaults: (infoPlist: Record<string, unknown>) => Record<string, unknown>;
  writeLocales: (
    projectRoot: string,
    projectName: string,
    locales: string[],
    strings: Record<string, Record<string, string>>,
  ) => string[];
  registerLocalisedInfoPlist: (
    project: XcodeProject,
    projectName: string,
    locales: string[],
  ) => { variantGroup: string; buildFile: string; parentGroup: string; locales: string[] };
  locateIosAppGroup: (project: XcodeProject, projectName: string) => { key: string; directory: string };
  resolvePermissionStrings: (
    config: Record<string, unknown>,
    props: Record<string, unknown>,
  ) => { locales: string[]; strings: Record<string, Record<string, string>> };
  NETWORK_SECURITY_CONFIG_XML: string;
  NETWORK_SECURITY_CONFIG_NAME: string;
  DEFAULT_PERMISSION_STRINGS: Record<string, Record<string, string>>;
  IOS_VARIANT_GROUP_NAME: string;
  IOS_RESOURCES_BUILD_PHASE: string;
};
// `xml2js` is a direct dependency of `@expo/config-plugins` (which the plugin loads), so it is
// always resolvable here; it is used only to prove the generated XML actually parses.
const xml2js = require('xml2js') as {
  parseStringPromise: (xml: string) => Promise<Record<string, any>>;
};
// `xcode` is what Expo's own `ios.xcodeproj` base mod parses `project.pbxproj` with; the tests
// parse the fixture (and every written background project) with the same library.
const xcode = require('xcode') as {
  project: (pbxprojPath: string) => XcodeProject;
};

/** The subset of the `xcode` project object this plugin (and these tests) touch. */
interface XcodeProject {
  hash: { project: { objects: Record<string, Record<string, any>> } };
  getFirstProject: () => { uuid: string; firstProject: Record<string, any> };
  getPBXGroupByKey: (key: string) => Record<string, any> | undefined;
  getPBXVariantGroupByKey: (key: string) => Record<string, any> | undefined;
  getTarget: (productType: string) => { uuid: string; target: Record<string, any> } | null;
  pbxResourcesBuildPhaseObj: (target: string) => { files: Array<{ value: string; comment?: string }> } | null;
  generateUuid: () => string;
  addKnownRegion: (name: string) => void;
  addToPbxBuildFileSection: (file: Record<string, unknown>) => void;
  addToPbxResourcesBuildPhase: (file: Record<string, unknown>) => void;
  parseSync: () => void;
  writeSync: () => string;
}

interface ManifestLike {
  manifest: { application: Array<{ $?: Record<string, string | boolean> }> };
}

/**
 * The config Expo hands the plugin for this app: `android` has no `usesCleartextTraffic` — that
 * field is not part of Expo's app config schema (expo-doctor rejects it), and it never reaches
 * the AndroidManifest, which is why the plugin authors the attribute itself.
 */
function baseConfig(): Record<string, unknown> {
  return {
    name: 'DSH Companion',
    slug: 'dsh-mobile',
    ios: {
      bundleIdentifier: 'com.dshext.companion',
      infoPlist: {
        NSCameraUsageDescription: 'Camera reason from app.json.',
        NSFaceIDUsageDescription: 'Face ID reason from app.json.',
      },
    },
    android: { package: 'com.dshext.companion' },
  };
}

/** The manifest Expo's template hands the mod: an `<application>` with no cleartext attribute. */
function manifestWith(cleartext: string | boolean | undefined, extra: Record<string, string> = {}): ManifestLike {
  const attributes: Record<string, string | boolean> = { 'android:name': '.MainApplication', ...extra };
  if (cleartext !== undefined) attributes['android:usesCleartextTraffic'] = cleartext;
  return { manifest: { application: [{ $: attributes }] } };
}

/** Run one of the plugin's prebuild mods the way Expo's mod compiler does. */
async function runMod(
  config: Record<string, unknown>,
  platform: 'android' | 'ios',
  modName: 'manifest' | 'dangerous' | 'infoPlist' | 'xcodeproj',
  modResults: unknown,
  projectRoot: string,
  projectName?: string,
): Promise<Record<string, any>> {
  const mods = (config as { mods?: Record<string, Record<string, unknown>> }).mods;
  const mod = mods?.[platform]?.[modName];
  assert.equal(typeof mod, 'function', `${platform}.${modName} mod is registered`);
  const result = await (mod as (config: Record<string, unknown>) => Promise<Record<string, any>>)({
    ...config,
    modResults,
    modRequest: {
      projectRoot,
      platformProjectRoot: path.join(projectRoot, platform),
      platform,
      modName,
      projectName,
      introspect: false,
      ignoreExistingNativeFiles: false,
    },
  });
  return result;
}

function attributesOf(manifest: ManifestLike): Record<string, string | boolean> {
  const attributes = manifest.manifest.application[0]?.$;
  assert.ok(attributes, 'application element has attributes');
  return attributes;
}

// ---------------------------------------------------------------------------
// Xcode project fixture (A033)
//
// A realistic `expo prebuild` iOS project for this app (Expo SDK 58 / React Native template
// shape): a Swift app target named DSHCompanion, its `PBXGroup` (name + path "DSHCompanion"), the
// Products group, Debug/Release configurations, `knownRegions` (en, Base — i.e. before this plugin
// adds vi) and a Resources build phase holding Images.xcassets. It is deliberately a *file* the
// `xcode` library parses, not a hand-inspected string: every assertion below runs on the parsed
// object graph, and the project is written back with `writeSync()` exactly as Expo's base mod does.
// ---------------------------------------------------------------------------
const PROJECT_PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 54;
	objects = {

/* Begin PBXBuildFile section */
		13B07FBC1A68108700A75B9A /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 13B07FBD1A68108700A75B9A /* AppDelegate.swift */; };
		13B07FBF1A68108700A75B9A /* Images.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = 13B07FBE1A68108700A75B9A /* Images.xcassets */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		13B07F961A680F5B00A75B9A /* DSHCompanion.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = DSHCompanion.app; sourceTree = BUILT_PRODUCTS_DIR; };
		13B07FB61A68108700A75B9A /* Info.plist */ = {isa = PBXFileReference; fileEncoding = 4; lastKnownFileType = text.plist.xml; name = Info.plist; path = Info.plist; sourceTree = "<group>"; };
		13B07FBD1A68108700A75B9A /* AppDelegate.swift */ = {isa = PBXFileReference; fileEncoding = 4; lastKnownFileType = sourcecode.swift; name = AppDelegate.swift; path = AppDelegate.swift; sourceTree = "<group>"; };
		13B07FBE1A68108700A75B9A /* Images.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; name = Images.xcassets; path = Images.xcassets; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		13B07F8C1A680F5B00A75B9A /* Frameworks */ = {
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		13B07FAE1A68108700A75B9A /* DSHCompanion */ = {
			isa = PBXGroup;
			children = (
				13B07FBD1A68108700A75B9A /* AppDelegate.swift */,
				13B07FBE1A68108700A75B9A /* Images.xcassets */,
				13B07FB61A68108700A75B9A /* Info.plist */,
			);
			name = DSHCompanion;
			path = DSHCompanion;
			sourceTree = "<group>";
		};
		83CBB9F71A601CBA00E9B192 = {
			isa = PBXGroup;
			children = (
				13B07FAE1A68108700A75B9A /* DSHCompanion */,
				83CBBA001A601CBA00E9B192 /* Products */,
			);
			indentWidth = 2;
			sourceTree = "<group>";
			tabWidth = 2;
			usesTabs = 0;
		};
		83CBBA001A601CBA00E9B192 /* Products */ = {
			isa = PBXGroup;
			children = (
				13B07F961A680F5B00A75B9A /* DSHCompanion.app */,
			);
			name = Products;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		13B07F861A680F5B00A75B9A /* DSHCompanion */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 13B07F931A680F5B00A75B9A /* Build configuration list for PBXNativeTarget "DSHCompanion" */;
			buildPhases = (
				13B07F871A680F5B00A75B9A /* Sources */,
				13B07F8C1A680F5B00A75B9A /* Frameworks */,
				13B07F8E1A680F5B00A75B9A /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = DSHCompanion;
			productName = DSHCompanion;
			productReference = 13B07F961A680F5B00A75B9A /* DSHCompanion.app */;
			productType = "com.apple.product-type.application";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		83CBB9F61A601CBA00E9B192 /* Project object */ = {
			isa = PBXProject;
			attributes = {
				LastUpgradeCheck = 1210;
				TargetAttributes = {
					13B07F861A680F5B00A75B9A = {
						LastSwiftMigration = 1120;
					};
				};
			};
			buildConfigurationList = 83CBB9FA1A601CBA00E9B192 /* Build configuration list for PBXProject "DSHCompanion" */;
			compatibilityVersion = "Xcode 12.0";
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				Base,
			);
			mainGroup = 83CBB9F71A601CBA00E9B192;
			productRefGroup = 83CBBA001A601CBA00E9B192 /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				13B07F861A680F5B00A75B9A /* DSHCompanion */,
			);
		};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		13B07F8E1A680F5B00A75B9A /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				13B07FBF1A68108700A75B9A /* Images.xcassets in Resources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		13B07F871A680F5B00A75B9A /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				13B07FBC1A68108700A75B9A /* AppDelegate.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		13B07F941A680F5B00A75B9A /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				CLANG_ENABLE_MODULES = YES;
				CURRENT_PROJECT_VERSION = 1;
				ENABLE_BITCODE = NO;
				INFOPLIST_FILE = DSHCompanion/Info.plist;
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 0.1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.dshext.companion;
				PRODUCT_NAME = DSHCompanion;
				SWIFT_OPTIMIZATION_LEVEL = "-Onone";
				SWIFT_VERSION = 5.0;
				VERSIONING_SYSTEM = "apple-generic";
			};
			name = Debug;
		};
		13B07F951A680F5B00A75B9A /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				CLANG_ENABLE_MODULES = YES;
				CURRENT_PROJECT_VERSION = 1;
				ENABLE_BITCODE = NO;
				INFOPLIST_FILE = DSHCompanion/Info.plist;
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 0.1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.dshext.companion;
				PRODUCT_NAME = DSHCompanion;
				SWIFT_VERSION = 5.0;
				VERSIONING_SYSTEM = "apple-generic";
			};
			name = Release;
		};
		83CBB9FC1A601CBA00E9B192 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 15.1;
				SDKROOT = iphoneos;
			};
			name = Debug;
		};
		83CBB9FD1A601CBA00E9B192 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 15.1;
				SDKROOT = iphoneos;
				VALIDATE_PRODUCT = YES;
			};
			name = Release;
		};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		13B07F931A680F5B00A75B9A /* Build configuration list for PBXNativeTarget "DSHCompanion" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				13B07F941A680F5B00A75B9A /* Debug */,
				13B07F951A680F5B00A75B9A /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		83CBB9FA1A601CBA00E9B192 /* Build configuration list for PBXProject "DSHCompanion" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				83CBB9FC1A601CBA00E9B192 /* Debug */,
				83CBB9FD1A601CBA00E9B192 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
/* End XCConfigurationList section */
	};
	rootObject = 83CBB9F61A601CBA00E9B192 /* Project object */;
}
`;

/** Path Expo's base mod and these tests use for the generated project. */
function pbxprojPath(root: string): string {
  return path.join(root, 'ios', 'DSHCompanion.xcodeproj', 'project.pbxproj');
}

/** Write the fixture project and return its `project.pbxproj` path. */
function writeFixtureProject(root: string, contents: string = PROJECT_PBXPROJ): string {
  const target = pbxprojPath(root);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  return target;
}

/** Parse a `project.pbxproj` with the same library Expo's `ios.xcodeproj` base mod uses. */
function parseProject(file: string): XcodeProject {
  const project = xcode.project(file);
  project.parseSync();
  return project;
}

/** Unquoted parsed pbxproj scalar (`"en"` -> `en`). */
function unquote(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : String(value);
}

interface XcodeEntry {
  key: string;
  object: Record<string, any>;
}

/** Non-comment entries of one parsed project section. */
function xcodeEntries(project: XcodeProject, isa: string): XcodeEntry[] {
  const section = project.hash.project.objects[isa] ?? {};
  return Object.keys(section)
    .filter((key) => !key.endsWith('_comment'))
    .map((key) => ({ key, object: section[key] }));
}

interface InfoPlistRegistration {
  variantGroups: XcodeEntry[];
  localizedFileRefs: XcodeEntry[];
  buildFiles: XcodeEntry[];
  resourceEntries: Array<{ value: string; comment?: string }>;
  knownRegions: string[];
  appGroupChildren: Array<{ value: string; comment?: string }>;
}

/** Everything about the InfoPlist.strings registration a bundling iOS project must get right. */
function infoPlistRegistration(project: XcodeProject): InfoPlistRegistration {
  const target = project.getTarget('com.apple.product-type.application');
  assert.ok(target, 'fixture has an application target');
  const resources = project.pbxResourcesBuildPhaseObj(target.uuid);
  assert.ok(resources, 'fixture has a Resources build phase');
  const variantGroups = xcodeEntries(project, 'PBXVariantGroup')
    .filter(({ object }) => unquote(object.name) === plugin.IOS_VARIANT_GROUP_NAME);
  const variantKeys = new Set(variantGroups.map(({ key }) => key));
  const localizedFileRefs = xcodeEntries(project, 'PBXFileReference')
    .filter(({ object }) => unquote(object.path).endsWith(`.lproj/${plugin.IOS_VARIANT_GROUP_NAME}`));
  const buildFiles = xcodeEntries(project, 'PBXBuildFile')
    .filter(({ object }) => variantKeys.has(unquote(object.fileRef)));
  // The app group is named after the target folder; a project without one falls back to the main
  // group (see the fallback test), so its absence is not an error here.
  const appGroup = xcodeEntries(project, 'PBXGroup')
    .find(({ object }) => unquote(object.name) === 'DSHCompanion');
  return {
    variantGroups,
    localizedFileRefs,
    buildFiles,
    resourceEntries: resources.files,
    knownRegions: (project.getFirstProject().firstProject.knownRegions ?? []).map((region: unknown) => unquote(region)),
    appGroupChildren: appGroup?.object.children ?? [],
  };
}

/** Run the plugin's `ios.xcodeproj` mod exactly as Expo's mod compiler does. */
async function runXcodeProjectMod(root: string, project: XcodeProject, projectName: string | undefined = 'DSHCompanion') {
  const config = plugin.withPinnedWsConfig(baseConfig());
  const result = await runMod(config, 'ios', 'xcodeproj', project, root, projectName);
  return result.modResults as XcodeProject;
}

describe('withPinnedWsConfig (A031)', () => {
  it('is registered as a run-once plugin function', () => {
    assert.equal(typeof plugin.withPinnedWsConfig, 'function');
    const applied = plugin.withPinnedWsConfig(baseConfig()) as { mods?: Record<string, Record<string, unknown>> };
    assert.ok(applied.mods?.android?.manifest, 'android manifest mod');
    assert.ok(applied.mods?.android?.dangerous, 'android dangerous mod (network security config)');
    assert.ok(applied.mods?.ios?.infoPlist, 'ios infoPlist mod');
    assert.ok(applied.mods?.ios?.dangerous, 'ios dangerous mod (InfoPlist.strings)');
    assert.ok(applied.mods?.ios?.xcodeproj, 'ios xcodeproj mod (register InfoPlist.strings)');
  });

  it('authors android:usesCleartextTraffic="false" when app.json leaves the attribute unset', () => {
    // This is the state `expo prebuild` produces: Expo copies nothing for a field it does not
    // know, so the template's <application> has no cleartext attribute at all.
    const manifest = plugin.applyNetworkSecurityConfig(manifestWith(undefined));
    const attributes = attributesOf(manifest);
    assert.equal(attributes['android:usesCleartextTraffic'], 'false');
    assert.equal(attributes['android:networkSecurityConfig'], '@xml/network_security_config');
  });

  it('keeps a "false" (string or boolean) that is already on the manifest', () => {
    for (const value of ['false', false]) {
      const attributes = attributesOf(plugin.applyNetworkSecurityConfig(manifestWith(value)));
      assert.equal(attributes['android:usesCleartextTraffic'], 'false', `value ${String(value)} normalised to "false"`);
    }
  });

  it('fails loudly when the manifest explicitly enables cleartext', () => {
    for (const value of ['true', true, '1', '']) {
      assert.throws(
        () => plugin.applyNetworkSecurityConfig(manifestWith(value)),
        /must be "false"/,
        `android:usesCleartextTraffic=${String(value)} must be rejected`,
      );
    }
  });

  it('refuses a manifest that points at a different network security config', () => {
    assert.throws(
      () => plugin.applyNetworkSecurityConfig(manifestWith(undefined, { 'android:networkSecurityConfig': '@xml/other' })),
      /must not point at a different network security config/,
    );
  });

  it('rejects android.usesCleartextTraffic in app.json, unsafe or stale', () => {
    // Unsafe: an explicit opt-in must never be silently dropped.
    for (const value of [true, 'true', 1]) {
      assert.throws(
        () =>
          plugin.withPinnedWsConfig({
            ...baseConfig(),
            android: { package: 'com.dshext.companion', usesCleartextTraffic: value },
          }),
        /must not set android\.usesCleartextTraffic/,
        `usesCleartextTraffic=${String(value)} must be rejected`,
      );
    }
    // Stale: `false` is the value the plugin enforces, but the FIELD breaks expo-doctor / EAS
    // ("additional property"), so leaving it in app.json still fails loudly with the fix.
    assert.throws(
      () =>
        plugin.withPinnedWsConfig({
          ...baseConfig(),
          android: { package: 'com.dshext.companion', usesCleartextTraffic: false },
        }),
      /must not set android\.usesCleartextTraffic/,
    );
    // The standard state — field absent — is accepted.
    assert.doesNotThrow(() => plugin.withPinnedWsConfig(baseConfig()));
    assert.doesNotThrow(() => plugin.assertNoCleartextOptIn({ android: { package: 'com.example' } }));
    assert.doesNotThrow(() => plugin.assertNoCleartextOptIn({}));
  });

  it('applies its manifest mod end-to-end (the mod Expo actually runs)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a031-mod-'));
    try {
      const config = plugin.withPinnedWsConfig(baseConfig());
      const result = await runMod(config, 'android', 'manifest', manifestWith(undefined), root);
      const attributes = attributesOf(result.modResults as ManifestLike);
      assert.equal(attributes['android:usesCleartextTraffic'], 'false');
      assert.equal(attributes['android:networkSecurityConfig'], '@xml/network_security_config');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies its dangerous android mod and writes res/xml/network_security_config.xml', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a031-dangerous-'));
    try {
      const config = plugin.withPinnedWsConfig(baseConfig());
      await runMod(config, 'android', 'dangerous', null, root);
      const target = path.join(root, 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml');
      assert.ok(existsSync(target), 'network_security_config.xml written by the dangerous mod');
      assert.equal(readFileSync(target, 'utf8'), plugin.NETWORK_SECURITY_CONFIG_XML);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps app.json free of the unsupported cleartext field and preserves the EAS identity', () => {
    // Regression for the actual EAS failure: expo-doctor rejects android.usesCleartextTraffic as
    // an additional property, which fails `eas build` before any Android artifact is produced.
    const appJson = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'app.json'), 'utf8')) as {
      expo: {
        slug?: string;
        owner?: string;
        android?: Record<string, unknown> & { permissions?: string[]; blockedPermissions?: string[] };
        extra?: { eas?: { projectId?: string } };
      };
    };
    const expo = appJson.expo;
    const android = expo.android;
    assert.ok(android, 'app.json keeps its android section');
    assert.equal('usesCleartextTraffic' in android, false, 'android.usesCleartextTraffic must not be in app.json');

    // The EAS project identity must survive config edits.
    assert.equal(expo.slug, 'dsh-mobile');
    assert.equal(expo.owner, 'nesteacolds-team');
    assert.equal(expo.extra?.eas?.projectId, '1352584f-32b4-4f00-9852-664315751e64');

    // A permission cannot be both requested and blocked; the manifest would get a grant and a
    // tools:node="remove" for the same name. RECORD_AUDIO is deliberately blocked.
    const requested = new Set(android.permissions ?? []);
    const blocked = new Set(android.blockedPermissions ?? []);
    assert.deepEqual(
      [...requested].filter((permission) => blocked.has(permission)),
      [],
      'no permission may be both requested and blocked',
    );
  });

  it('generates a well-formed network security config that trusts no CA and permits no cleartext', async () => {
    const xml = plugin.NETWORK_SECURITY_CONFIG_XML;
    assert.match(xml, /<base-config cleartextTrafficPermitted="false">/);
    // The block may hold only comments: no anchor is declared, so neither the system CA store
    // nor user-installed CAs can be trusted.
    const anchors = /<trust-anchors>([\s\S]*?)<\/trust-anchors>/.exec(xml);
    assert.ok(anchors, 'trust-anchors block must exist');
    assert.equal(anchors[1]!.replace(/<!--[\s\S]*?-->/g, '').trim(), '');
    assert.doesNotMatch(xml, /<certificates/);
    assert.doesNotMatch(xml, /debug-overrides/);
    // And nothing is pinned as a CA: the only identity is the leaf pin in modules/pinned-ws.
    assert.doesNotMatch(xml, /@raw\//);

    // "Empty" here means an element with no element children, not a malformed file: AAPT2 ships
    // res/xml verbatim and Android's XmlConfigSource accepts an empty <trust-anchors> (it means
    // "trust no anchor", whereas an ABSENT element falls back to the platform CA store). The
    // parser check below pins the well-formedness half of that; the runtime half needs a device.
    const parsed = await xml2js.parseStringPromise(xml);
    const baseConfig = parsed['network-security-config']?.['base-config']?.[0];
    assert.ok(baseConfig, 'base-config element');
    assert.equal(baseConfig.$.cleartextTrafficPermitted, 'false');
    const trustAnchors = baseConfig['trust-anchors'];
    assert.ok(Array.isArray(trustAnchors), 'trust-anchors element present');
    assert.equal(trustAnchors.length, 1);
    // xml2js flattens an element without element children to its (whitespace-only) text: no
    // <certificates src="..."> child means "trust no anchor" instead of the platform CA store.
    assert.equal(typeof trustAnchors[0], 'string', 'trust-anchors has no child elements');
    assert.equal(trustAnchors[0].trim(), '', 'trust-anchors holds only whitespace');
  });

  it('writes res/xml/network_security_config.xml under the generated android project', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a031-android-'));
    try {
      const target = plugin.writeNetworkSecurityConfig(root);
      assert.equal(target, path.join(root, 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml'));
      assert.equal(readFileSync(target, 'utf8'), plugin.NETWORK_SECURITY_CONFIG_XML);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts the ATS default and rejects ATS exceptions', () => {
    assert.doesNotThrow(() => plugin.assertAtsDefaults({ NSCameraUsageDescription: 'x' }));
    assert.doesNotThrow(() => plugin.assertAtsDefaults({ NSAppTransportSecurity: {} }));
    assert.throws(
      () => plugin.assertAtsDefaults({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }),
      /must not add ATS exceptions/,
    );
    assert.throws(
      () =>
        plugin.assertAtsDefaults({
          NSAppTransportSecurity: { NSExceptionDomains: { 'example.com': { NSExceptionAllowsInsecureHTTPLoads: true } } },
        }),
      /must not add ATS exceptions/,
    );
  });

  it('rejects ATS opt-ins from app.json but accepts Expo introspection defaults in modResults', async () => {
    const withAts = (ats: Record<string, unknown>): Record<string, unknown> => {
      const config = baseConfig();
      const ios = config.ios as Record<string, unknown>;
      return { ...config, ios: { ...ios, infoPlist: { NSAppTransportSecurity: ats } } };
    };

    assert.throws(
      () => plugin.withPinnedWsConfig(withAts({ NSAllowsArbitraryLoads: true })),
      /must not add ATS exceptions/,
    );
    assert.throws(
      () =>
        plugin.withPinnedWsConfig(
          withAts({ NSExceptionDomains: { 'example.com': { NSExceptionAllowsInsecureHTTPLoads: true } } }),
        ),
      /must not add ATS exceptions/,
    );
    assert.doesNotThrow(() => plugin.assertNoAtsOptIn({}));
    assert.doesNotThrow(() => plugin.assertNoAtsOptIn({ ios: {} }));

    // Expo's introspection base mod injects NSAllowsArbitraryLoads=true + a localhost exception
    // into modResults when no ios/ project exists. That is Expo's fallback, not an app.json
    // opt-in; treating it as one made `expo config --type introspect` fail. A real prebuild uses
    // the safer template (NSAllowsArbitraryLoads=false, NSAllowsLocalNetworking=true).
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a031-ats-introspect-'));
    try {
      const config = plugin.withPinnedWsConfig(baseConfig());
      const expoDefaults = {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
          NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true } },
        },
      };
      const result = await runMod(config, 'ios', 'infoPlist', expoDefaults, root);
      assert.deepEqual(result.modResults.NSAppTransportSecurity, expoDefaults.NSAppTransportSecurity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the English permission strings identical to app.json', () => {
    const resolved = plugin.resolvePermissionStrings(baseConfig(), { locales: ['en', 'vi'] });
    assert.deepEqual(resolved.locales, ['en', 'vi']);
    assert.equal(resolved.strings.en!.NSCameraUsageDescription, 'Camera reason from app.json.');
    assert.equal(resolved.strings.en!.NSFaceIDUsageDescription, 'Face ID reason from app.json.');
    // Vietnamese is a translation, never a copy of the English text.
    assert.notEqual(resolved.strings.vi!.NSCameraUsageDescription, resolved.strings.en!.NSCameraUsageDescription);
  });

  it('writes vi + en InfoPlist.strings with camera and Face ID strings', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a031-ios-'));
    try {
      const resolved = plugin.resolvePermissionStrings(baseConfig(), { locales: ['en', 'vi'] });
      plugin.writeLocales(root, 'DSHCompanion', resolved.locales, resolved.strings);
      const iosTarget = path.join(root, 'ios', 'DSHCompanion');

      for (const locale of ['en', 'vi']) {
        const file = path.join(iosTarget, `${locale}.lproj`, 'InfoPlist.strings');
        assert.ok(existsSync(file), `${locale}.lproj/InfoPlist.strings missing`);
        const text = readFileSync(file, 'utf8');
        assert.match(text, /^\/\* Generated/m);
        assert.ok(text.includes(`"NSFaceIDUsageDescription" = "${resolved.strings[locale]!.NSFaceIDUsageDescription}";`));
        assert.ok(text.includes(`"NSCameraUsageDescription" = "${resolved.strings[locale]!.NSCameraUsageDescription}";`));
      }
      const en = readFileSync(path.join(iosTarget, 'en.lproj', 'InfoPlist.strings'), 'utf8');
      const vi = readFileSync(path.join(iosTarget, 'vi.lproj', 'InfoPlist.strings'), 'utf8');
      assert.notEqual(vi, en);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects locale folder names that are not language tags', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a031-badlocale-'));
    try {
      assert.throws(
        () => plugin.writeLocales(root, 'DSHCompanion', ['../evil'], { '../evil': { NSCameraUsageDescription: 'x' } }),
        /unsupported locale/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A033 — `.lproj` files must be referenced from `project.pbxproj`, or Xcode never copies them.
describe('withPinnedWsConfig — Xcode registration of InfoPlist.strings (A033)', () => {
  it('registers the en + vi files the dangerous mod wrote, so Xcode bundles them', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a033-ios-'));
    try {
      const config = plugin.withPinnedWsConfig(baseConfig());
      // `expo prebuild` runs `dangerous` mods before `xcodeproj` mods: files first, registration second.
      await runMod(config, 'ios', 'dangerous', null, root, 'DSHCompanion');
      const project = parseProject(writeFixtureProject(root));
      const before = infoPlistRegistration(project);
      assert.deepEqual(before.variantGroups, [], 'fixture starts without a variant group');
      assert.deepEqual(before.knownRegions, ['en', 'Base'], 'fixture starts without the vi region');

      const applied = await runXcodeProjectMod(root, project);
      const written = applied.writeSync();
      writeFileSync(pbxprojPath(root), written, 'utf8');
      const parsed = parseProject(pbxprojPath(root));
      const registration = infoPlistRegistration(parsed);

      // Exactly one variant group, inside the app group, carrying one child per locale.
      assert.equal(registration.variantGroups.length, 1, 'one InfoPlist.strings variant group');
      assert.equal(registration.localizedFileRefs.length, 2, 'one file reference per locale, no duplicates');
      const variant = registration.variantGroups[0]!;
      const children = (variant.object.children ?? []) as Array<{ value: string; comment: string }>;
      assert.deepEqual(children.map((child) => unquote(child.comment)), ['en', 'vi']);
      assert.ok(
        registration.appGroupChildren.some((child) => unquote(child.value) === variant.key),
        'the variant group is a child of the DSHCompanion PBXGroup',
      );

      // Each child is a localised .strings file reference that resolves to the file on disk.
      const appGroup = plugin.locateIosAppGroup(parsed, 'DSHCompanion');
      assert.equal(appGroup.directory, 'DSHCompanion', 'app group folder');
      const fileRefs = new Map(xcodeEntries(parsed, 'PBXFileReference').map((entry) => [entry.key, entry.object]));
      for (const child of children) {
        const locale = unquote(child.comment);
        const ref = fileRefs.get(unquote(child.value));
        assert.ok(ref, `file reference for ${locale}`);
        assert.equal(unquote(ref.name), locale, `${locale} file reference is named after the locale`);
        assert.equal(unquote(ref.path), `${locale}.lproj/${plugin.IOS_VARIANT_GROUP_NAME}`);
        assert.equal(unquote(ref.lastKnownFileType), 'text.plist.strings');
        assert.equal(unquote(ref.sourceTree), '<group>');
        const resolved = path.join(root, 'ios', appGroup.directory, unquote(ref.path));
        assert.ok(existsSync(resolved), `${locale} resolved path exists: ${resolved}`);
      }

      // One build file in the Resources build phase: that is what makes Xcode copy the group.
      assert.equal(registration.buildFiles.length, 1, 'exactly one build file references the variant group');
      const buildFile = registration.buildFiles[0]!;
      const resourceEntries = registration.resourceEntries.filter(
        (entry) => unquote(entry.value) === buildFile.key,
      );
      assert.equal(resourceEntries.length, 1, 'exactly one Resources entry for the variant group');
      assert.equal(resourceEntries[0]!.comment, `${plugin.IOS_VARIANT_GROUP_NAME} in Resources`);
      // The pre-existing resources entry is untouched.
      assert.ok(
        registration.resourceEntries.some((entry) => unquote(entry.value) === '13B07FBF1A68108700A75B9A'),
        'Images.xcassets stays in the Resources build phase',
      );

      // vi is now a known localisation next to the template's en + Base.
      assert.deepEqual(registration.knownRegions, ['en', 'Base', 'vi']);
      assert.match(written, /isa = "PBXVariantGroup";/);
      // The variant group's build file appears twice in pbxproj text: its definition and the
      // Resources build-phase entry that references it.
      assert.equal(
        (written.match(/InfoPlist\.strings in Resources/g) ?? []).length,
        2,
        'one build-file definition and one Resources-phase reference',
      );
      assert.ok(
        written.includes(`${buildFile.key} /* ${plugin.IOS_VARIANT_GROUP_NAME} in Resources */,`),
        'the Resources build phase references the variant group build file',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second prebuild over the same project changes nothing', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a033-idempotent-'));
    try {
      writeFixtureProject(root);
      const first = await runXcodeProjectMod(root, parseProject(pbxprojPath(root)));
      const firstText = first.writeSync();
      writeFileSync(pbxprojPath(root), firstText, 'utf8');

      // `expo prebuild` without `--clean` parses the project the previous run wrote.
      const second = await runXcodeProjectMod(root, parseProject(pbxprojPath(root)));
      const secondText = second.writeSync();
      assert.equal(secondText, firstText, 'the second registration is a byte-for-byte no-op');

      writeFileSync(pbxprojPath(root), secondText, 'utf8');
      const registration = infoPlistRegistration(parseProject(pbxprojPath(root)));
      assert.equal(registration.variantGroups.length, 1, 'no duplicate variant group');
      const children = (registration.variantGroups[0]!.object.children ?? []) as Array<{ comment: string }>;
      assert.deepEqual(children.map((child) => unquote(child.comment)), ['en', 'vi'], 'no duplicate children');
      assert.equal(registration.buildFiles.length, 1, 'no duplicate build file');
      assert.equal(
        registration.resourceEntries.filter((entry) => entry.comment === `${plugin.IOS_VARIANT_GROUP_NAME} in Resources`).length,
        1,
        'no duplicate Resources entry',
      );
      assert.deepEqual(registration.knownRegions, ['en', 'Base', 'vi'], 'no duplicate known region');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('folds a plain (non-variant) registration of the same files into the variant group', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a033-legacy-'));
    const legacyBuildFile = 'AA00AA00AA00AA00AA00AA00';
    const legacyFileRef = 'BB00BB00BB00BB00BB00BB00';
    // A project that already bundles en.lproj/InfoPlist.strings as a lone file reference (the
    // shape an older plugin version or a hand edit leaves behind): two registrations of the same
    // path would make Xcode fail with "Multiple commands produce .../InfoPlist.strings".
    const fixture = PROJECT_PBXPROJ
      .replace(
        '/* End PBXBuildFile section */',
        `\t\t${legacyBuildFile} /* en.lproj/InfoPlist.strings in Resources */ = {isa = PBXBuildFile; fileRef = ${legacyFileRef} /* en */; };\n/* End PBXBuildFile section */`,
      )
      .replace(
        '/* End PBXFileReference section */',
        `\t\t${legacyFileRef} /* en */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = en; path = en.lproj/InfoPlist.strings; sourceTree = "<group>"; };\n/* End PBXFileReference section */`,
      )
      .replace(
        '\t\t\t\t13B07FBF1A68108700A75B9A /* Images.xcassets in Resources */,',
        `\t\t\t\t13B07FBF1A68108700A75B9A /* Images.xcassets in Resources */,\n\t\t\t\t${legacyBuildFile} /* en.lproj/InfoPlist.strings in Resources */,`,
      );
    try {
      writeFixtureProject(root, fixture);
      const project = parseProject(pbxprojPath(root));
      const applied = await runXcodeProjectMod(root, project);
      const written = applied.writeSync();
      writeFileSync(pbxprojPath(root), written, 'utf8');
      const registration = infoPlistRegistration(parseProject(pbxprojPath(root)));

      const children = (registration.variantGroups[0]!.object.children ?? []) as Array<{ value: string; comment: string }>;
      assert.deepEqual(children.map((child) => unquote(child.comment)), ['en', 'vi']);
      assert.equal(unquote(children[0]!.value), legacyFileRef, 'the existing en file reference is reused');
      assert.equal(registration.buildFiles.length, 1, 'only the variant-group build file remains');
      assert.notEqual(registration.buildFiles[0]!.key, legacyBuildFile, 'the standalone build file was removed');
      assert.equal(
        registration.resourceEntries.filter((entry) => entry.comment?.includes(plugin.IOS_VARIANT_GROUP_NAME)).length,
        1,
        'exactly one InfoPlist.strings resource entry',
      );
      assert.equal(
        xcodeEntries(parseProject(pbxprojPath(root)), 'PBXBuildFile').some(({ key }) => key === legacyBuildFile),
        false,
        'the standalone PBXBuildFile is gone from the project',
      );
      const fileRefs = xcodeEntries(parseProject(pbxprojPath(root)), 'PBXFileReference')
        .filter(({ object }) => unquote(object.path).endsWith(`.lproj/${plugin.IOS_VARIANT_GROUP_NAME}`));
      assert.equal(fileRefs.length, 2, 'two file references: en and vi, no duplicate en');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the main group when the project has no group named after the app', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a033-fallback-'));
    try {
      // A project whose app files live directly under the main group (no `DSHCompanion` PBXGroup).
      const fixture = PROJECT_PBXPROJ.replace(
        /name = DSHCompanion;\s*\n\s*path = DSHCompanion;/,
        'name = AppTarget;\n\t\t\tpath = AppTarget;',
      );
      const project = parseProject(writeFixtureProject(root, fixture));
      const located = plugin.locateIosAppGroup(project, 'DSHCompanion');
      assert.equal(located.directory, '', 'fallback is the main group (ios/ itself)');

      const applied = await runXcodeProjectMod(root, project);
      const written = applied.writeSync();
      writeFileSync(pbxprojPath(root), written, 'utf8');
      const parsed = parseProject(pbxprojPath(root));
      const paths = xcodeEntries(parsed, 'PBXFileReference')
        .map(({ object }) => unquote(object.path))
        .filter((value) => value.endsWith(`.lproj/${plugin.IOS_VARIANT_GROUP_NAME}`));
      // Relative to ios/, because the variant group now hangs off the main group.
      assert.deepEqual(paths.sort(), [
        `DSHCompanion/en.lproj/${plugin.IOS_VARIANT_GROUP_NAME}`,
        `DSHCompanion/vi.lproj/${plugin.IOS_VARIANT_GROUP_NAME}`,
      ]);
      assert.equal(infoPlistRegistration(parsed).buildFiles.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds no xcodeproj mod when the requested locales have no permission strings', () => {
    const config = plugin.withPinnedWsConfig(baseConfig(), { locales: ['fr'] }) as {
      mods?: Record<string, Record<string, unknown>>;
    };
    assert.ok(config.mods?.ios?.dangerous, 'the .strings writer mod stays registered');
    assert.equal(config.mods?.ios?.xcodeproj, undefined, 'nothing would be written, so nothing is registered');
  });

  it('fails loudly when the xcodeproj mod provides no parsed project', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a033-no-project-'));
    try {
      const config = plugin.withPinnedWsConfig(baseConfig());
      await assert.rejects(
        () => runMod(config, 'ios', 'xcodeproj', {}, root, 'DSHCompanion'),
        /did not provide a parsed Xcode project/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loudly instead of silently bundling nothing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-a033-fail-'));
    try {
      // No application target.
      const frameworkFixture = PROJECT_PBXPROJ.replace(
        'productType = "com.apple.product-type.application";',
        'productType = "com.apple.product-type.framework";',
      );
      assert.throws(
        () => plugin.registerLocalisedInfoPlist(parseProject(writeFixtureProject(root, frameworkFixture)), 'DSHCompanion', ['en']),
        /has no com\.apple\.product-type\.application target/,
      );
      // No project name: the .lproj files cannot be resolved to a folder.
      assert.throws(
        () => plugin.registerLocalisedInfoPlist(parseProject(writeFixtureProject(root)), '', ['en']),
        /iOS project name is unknown/,
      );
      // No Resources build phase.
      const noResourcesFixture = PROJECT_PBXPROJ.replace(
        /13B07F8E1A680F5B00A75B9A \/\* Resources \*\/ = \{[\s\S]*?\};/,
        '',
      );
      assert.throws(
        () => plugin.registerLocalisedInfoPlist(parseProject(writeFixtureProject(root, noResourcesFixture)), 'DSHCompanion', ['en']),
        /no Resources build phase/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
