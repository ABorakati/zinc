// The update PUBLIC key that build.ts embeds in the exe (src/update/config.ts reads it as process.env.ZN_UPDATE_PUBKEY).
//
// Where it comes from, first hit wins:
//   ZN_UPDATE_PUBKEY        the key itself: raw Ed25519 public key, base64 (44 characters)
//   ZN_UPDATE_PUBKEY_FILE   a file holding that text (e.g. the release-key.public.txt that `release.ts --keygen` writes)
//   gpui-ui/update-pubkey.txt   the same, checked in once you have generated your real key (a PUBLIC key is safe to commit)
// None found: "" - the build then cannot verify any manifest and never updates (it says so in Settings > System > Updates).
// The PRIVATE key must never be here; it is read only by scripts/release.ts (ZN_UPDATE_KEY) and lives outside the repo.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const checkedIn = resolve(import.meta.dir, "..", "update-pubkey.txt");

export function updatePubkey(): string {
	const raw = (
		process.env.ZN_UPDATE_PUBKEY ??
		(process.env.ZN_UPDATE_PUBKEY_FILE ? readFileSync(process.env.ZN_UPDATE_PUBKEY_FILE, "utf8") : undefined) ??
		(existsSync(checkedIn) ? readFileSync(checkedIn, "utf8") : "")
	).trim();
	if (!raw) {
		console.warn(
			"[update] no update public key (ZN_UPDATE_PUBKEY / ZN_UPDATE_PUBKEY_FILE / gpui-ui/update-pubkey.txt): this build will not auto-update",
		);
		return "";
	}
	if (Buffer.from(raw, "base64").length !== 32) throw new Error("the update public key is not a base64 32-byte Ed25519 key");
	return raw;
}
