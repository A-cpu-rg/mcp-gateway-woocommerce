function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing env ${name}`);
  return v;
}

export interface LlmConfig {
  provider: 'azure' | 'openai';
  /** azure: https://<resource>.openai.azure.com/ ; openai: any OpenAI-compatible base URL ending in /v1 */
  endpoint: string;
  apiKey: string;
  /** azure: deployment name; openai: model name */
  model: string;
  apiVersion: string;
}

export interface Config {
  port: number;
  databaseUrl: string;
  /** 32-byte key (base64) used to encrypt upstream credentials at rest. */
  encryptionKey: Buffer;
  publicUrl: string;
  cookieSecure: boolean;
  /** Host patterns allowed to resolve to private/loopback addresses (e.g. *.svc.cluster.local). */
  upstreamAllowedHosts: string[];
  healthIntervalMs: number;
  bootstrapAdmin?: { email: string; password: string };
  /** JSON array of servers registered on first start (see seed.ts). */
  seedServers?: string;
  llm?: LlmConfig;
  dashboardDir?: string;
}

export function loadConfig(): Config {
  const key = Buffer.from(env('ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  const llmKey = process.env.LLM_API_KEY;
  return {
    port: Number(env('PORT', '8080')),
    databaseUrl: env('DATABASE_URL'),
    encryptionKey: key,
    publicUrl: env('PUBLIC_URL', 'http://localhost:8080').replace(/\/$/, ''),
    cookieSecure: env('COOKIE_SECURE', 'false') === 'true',
    upstreamAllowedHosts: env('UPSTREAM_ALLOWED_HOSTS', '*.svc.cluster.local')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    healthIntervalMs: Number(env('HEALTH_INTERVAL_MS', '10000')),
    bootstrapAdmin:
      process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
        ? { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
        : undefined,
    seedServers: process.env.SEED_SERVERS,
    llm: llmKey
      ? {
          provider: env('LLM_PROVIDER', 'azure') === 'openai' ? 'openai' : 'azure',
          endpoint: env('LLM_ENDPOINT'),
          apiKey: llmKey,
          model: env('LLM_MODEL'),
          apiVersion: env('LLM_API_VERSION', '2024-12-01-preview'),
        }
      : undefined,
    dashboardDir: process.env.DASHBOARD_DIR,
  };
}
