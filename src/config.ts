import fs from 'fs';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function getEnvOrDefault(name: string, defaultValue: string): string {
  const val = process.env[name];
  if (!val) {
    return defaultValue;
  }
  return val;
}

function isRunningInDocker(): boolean {
  // häufigster Indikator
  try {
    if (fs.existsSync("/.dockerenv")) return true;
  } catch {}

  return false;
}

export const config = {
  immichHost: requireEnv('IMMICH_HOST'),
  TZ: requireEnv('TZ'),
  hostKeyDir: getEnvOrDefault('HOST_KEY_DIR', isRunningInDocker() ? '/data/ssh-host-key' : './data/ssh-host-key'),
};
