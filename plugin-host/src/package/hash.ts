export const sha256Hex = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
