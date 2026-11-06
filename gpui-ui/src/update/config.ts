// What a build knows about updates. build.ts replaces these two expressions at build time (Bun.build `define`):
//   process.env.ZN_UPDATE_PUBKEY  the raw Ed25519 PUBLIC key, base64 (from ZN_UPDATE_PUBKEY or the file ZN_UPDATE_PUBKEY_FILE). Empty: this
//                                 build cannot verify a manifest, so it never updates. A packaged exe cannot be pointed at another key.
//   process.env.ZN_UPDATE_URL     the default feed URL (https, the latest.json). Empty until a feed is published.
// An unpackaged run (bun src/main.tsx, tests) reads the same variables from the environment at run time.
// The user can still override the feed in Settings > System > Updates; the signature check protects against a wrong or hostile feed.

/** Ed25519 public key (raw, base64) that signs the manifests this build accepts. */
export const UPDATE_PUBKEY: string = process.env.ZN_UPDATE_PUBKEY ?? "";

/** Feed URL used when Settings has none. */
export const DEFAULT_FEED_URL: string = process.env.ZN_UPDATE_URL ?? "";
