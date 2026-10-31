import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "reclaim-api-key";

export function readApiKey(): string {
  const fromEnv = process.env.RECLAIM_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  if (process.platform === "darwin") {
    try {
      const fromKeychain = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (fromKeychain) return fromKeychain;
    } catch {
      // `security` exits non-zero when the item does not exist.
    }
  }

  throw new Error(
    `Reclaim API key not found. Set RECLAIM_API_KEY, or on macOS add it to the Keychain with: ` +
      `security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w`,
  );
}
