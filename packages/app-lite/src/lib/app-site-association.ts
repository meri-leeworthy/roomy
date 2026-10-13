/**
 * The Apple App Site Association (AASA) — the file Apple fetches from
 * `/.well-known/apple-app-site-association` on a domain before the system lets
 * a shared `https://` link open the iOS app instead of the web app.
 *
 * It is the served half of the claim `src-tauri/tauri.conf.json` makes: the
 * deep-link plugin's build script writes
 * `com.apple.developer.associated-domains = ["applinks:<host>"]` into the app's
 * entitlements, and the system honours that only for a domain whose AASA names
 * an `appID` that app is entitled to claim. An entitlement with no association
 * file is a signed claim nobody can verify — Apple's CDN answers 404 for the
 * domain and every link opens the browser.
 *
 * `scripts/gen-aasa.mjs` writes the file into the build output. It is not
 * committed: its `appIDs` entry is `<Team ID>.<Bundle ID>`, and the Team ID is
 * an Apple account property supplied through `APPLE_DEVELOPMENT_TEAM`, not a
 * repository constant. A build that lacks it fails rather than serving a file
 * whose appIDs cannot match the app — the same contract as the OAuth metadata
 * and build-identity verifications in `scripts/build-prod.sh`.
 *
 * `tauri.conf.json` is the single source of truth for the host and path
 * prefixes of the claim: it drives the served `components` here and the Android
 * intent filter's `pathPrefix`. This module does not read it — the generator
 * parses it and passes the values in — which keeps the mapping pure and
 * testable without a filesystem or a build environment.
 */

/** Where the association file must be served from, and the only path Apple reads. */
export const AASA_PATH = "/.well-known/apple-app-site-association";

/** Build variable carrying the Apple Developer Team ID (e.g. `ABCDE12345`). */
export const TEAM_ID_ENV = "APPLE_DEVELOPMENT_TEAM";

/**
 * Apple issues Developer Team IDs as ten upper-case alphanumeric characters.
 * Any other value is wrong or a placeholder: the system compares the served
 * `appID` against the app's entitlement, so a wrong Team ID produces a file
 * that parses cleanly and never matches anything.
 */
const TEAM_ID = /^[A-Z0-9]{10}$/;

/** One entry of `plugins > deep-link > mobile`. */
export interface DeepLinkEntry {
  scheme?: string[];
  host?: string;
  pathPrefix?: string[];
  appLink?: boolean;
}

/** The `tauri.conf.json` fields this module reads. */
export interface TauriConfig {
  identifier?: string;
  plugins?: {
    "deep-link"?: {
      mobile?: DeepLinkEntry[];
    };
  };
}

/**
 * A URL pattern the app claims, as `tauri.conf.json` declares it.
 *
 * `pathPrefixes` is exactly what the `https` appLink entry lists — the value
 * Android's intent filter is generated from and the value the AASA must cover.
 */
export interface AppLinkClaim {
  host: string;
  pathPrefixes: string[];
}

/**
 * The `https` appLink claim in `tauri.conf.json`.
 *
 * Exactly one entry may claim universal links: two would mean two hosts (or two
 * prefixes) the served association could not distinguish, and the file names
 * one app for one domain.
 */
export function readAppLinkClaim(config: TauriConfig): AppLinkClaim {
  const entries = config.plugins?.["deep-link"]?.mobile ?? [];
  const claims = entries.filter(
    (entry) => entry.appLink === true && (entry.scheme ?? []).includes("https"),
  );
  if (claims.length !== 1) {
    throw new Error(
      `src-tauri/tauri.conf.json must declare exactly one https appLink entry, found ${claims.length}`,
    );
  }
  const [claim] = claims;
  if (!claim) {
    throw new Error("src-tauri/tauri.conf.json declares no https appLink entry");
  }
  const host = claim.host;
  if (!host) {
    throw new Error(
      "the https appLink entry in src-tauri/tauri.conf.json has no host",
    );
  }
  const pathPrefixes = claim.pathPrefix ?? [];
  if (pathPrefixes.length === 0) {
    throw new Error(
      "the https appLink entry in src-tauri/tauri.conf.json declares no pathPrefix: " +
        'state the prefix the app claims (the whole site is "/") so the served ' +
        "components can be derived from it",
    );
  }
  return { host, pathPrefixes };
}

/** The bundle identifier the appIDs are built from (`tauri.conf.json > identifier`). */
export function readBundleId(config: TauriConfig): string {
  const identifier = config.identifier?.trim();
  if (!identifier) {
    throw new Error("src-tauri/tauri.conf.json declares no identifier");
  }
  return identifier;
}

/**
 * The `components` matching every URL under `pathPrefixes`, one entry each.
 *
 * Apple matches a component's `/` as a whole-path pattern (`*` is zero or more
 * characters) while `tauri.conf.json` declares a plain prefix, so a prefix
 * becomes `<prefix>*`: the whole site (`"/"`) becomes `"/*"`. Deriving one from
 * the other is what keeps the file honest about the claim — a prefix the file
 * does not cover is a link the entitlement opens the app for and the
 * association refuses, and with `pathPrefix: ["/"]` one `"/*"` entry matches
 * every URL on the host.
 */
export function aasaComponents(
  pathPrefixes: readonly string[],
): { "/": string }[] {
  if (pathPrefixes.length === 0) {
    throw new Error("the association file needs at least one path prefix");
  }
  return pathPrefixes.map((prefix) => {
    if (!prefix.startsWith("/")) {
      throw new Error(`pathPrefix must start with "/", got ${JSON.stringify(prefix)}`);
    }
    return { "/": `${prefix}*` };
  });
}

/** The wire shape Apple's CDN parses. */
export interface AppSiteAssociation {
  applinks: {
    details: {
      appIDs: string[];
      components: { "/": string }[];
    }[];
  };
}

/**
 * The association file for one app.
 *
 * `teamId` and `bundleId` are joined into the single `appIDs` entry Apple
 * matches against the app's associated-domains entitlement, so either being
 * wrong yields a file that is served, parses, and associates nothing.
 */
export function buildAppSiteAssociation(input: {
  teamId: string;
  bundleId: string;
  pathPrefixes: readonly string[];
}): AppSiteAssociation {
  const teamId = input.teamId.trim();
  if (!TEAM_ID.test(teamId)) {
    throw new Error(
      `${TEAM_ID_ENV} must be the ten-character Apple Developer Team ID, got ${JSON.stringify(input.teamId)}`,
    );
  }
  const bundleId = input.bundleId.trim();
  if (!bundleId) {
    throw new Error("the association file needs a bundle identifier");
  }
  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${bundleId}`],
          components: aasaComponents(input.pathPrefixes),
        },
      ],
    },
  };
}
