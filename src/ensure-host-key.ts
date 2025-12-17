import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function ensureHostKeySync(hostKeyDir: string): Buffer {
  fs.mkdirSync(hostKeyDir, { recursive: true });

  let hostKeyFile = path.join(hostKeyDir, "host.key");

  if (!fs.existsSync(hostKeyFile)) {
    // OpenSSH-kompatiblen Host-Key erzeugen
    execFileSync("ssh-keygen", ["-t", "ed25519", "-f", hostKeyFile, "-N", ""], {
      stdio: "inherit",
    });

    // Permissions (unter Windows ggf. wirkungslos, aber ok)
    try { fs.chmodSync(hostKeyFile, 0o600); } catch {}
  }

  return fs.readFileSync(hostKeyFile);
}
