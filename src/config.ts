// src/config.ts

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export const config = {
  immichHost: requireEnv('IMMICH_HOST'),
  TZ: requireEnv('TZ'),
};
