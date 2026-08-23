export const EVENT_SCHEMA_VERSION = '1.0.0';
export const CANONICAL_ORIGIN = process.env.NOURA_CANONICAL_ORIGIN ?? 'https://learnwithnoura.com';

export type DeploymentMode = 'local-synthetic' | 'preview-synthetic' | 'production';

export interface RuntimeConfig {
  deploymentMode: DeploymentMode;
  production: boolean;
  syntheticOnly: boolean;
  providerConfigured: boolean;
  durableStorageConfigured: boolean;
  authenticationConfigured: boolean;
  privacyConfigured: boolean;
  realtimeModel: string;
  textModel: string;
  buildSha: string;
  environment: string;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const inferred = env.VERCEL_ENV === 'production'
    ? 'production'
    : env.VERCEL_ENV === 'preview'
      ? 'preview-synthetic'
      : 'local-synthetic';
  const requested = env.NOURA_DEPLOYMENT_MODE ?? inferred;
  const deploymentMode: DeploymentMode = requested === 'production'
    ? 'production'
    : requested === 'preview-synthetic'
      ? 'preview-synthetic'
      : 'local-synthetic';
  const production = deploymentMode === 'production';

  return {
    deploymentMode,
    production,
    syntheticOnly: !production || env.NOURA_SYNTHETIC_ONLY !== 'false',
    providerConfigured: Boolean(env.OPENAI_API_KEY),
    durableStorageConfigured: Boolean(env.DATABASE_URL),
    authenticationConfigured: Boolean(env.NOURA_AUTH_SECRET && env.NOURA_AUTH_PROVIDER),
    privacyConfigured: Boolean(env.NOURA_PRIVACY_POLICY_VERSION && env.NOURA_SAFETY_MODE),
    realtimeModel: env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
    textModel: env.OPENAI_MODEL || 'gpt-5.6-terra',
    buildSha: env.NOURA_BUILD_SHA || env.VERCEL_GIT_COMMIT_SHA || 'local-uncommitted',
    environment: env.VERCEL_ENV || deploymentMode,
  };
}

export function productionReadinessErrors(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!config.production) return [];
  const errors: string[] = [];
  if (!config.durableStorageConfigured) errors.push('durable managed storage is not configured');
  if (!config.authenticationConfigured) errors.push('parent authentication is not configured');
  if (!config.privacyConfigured) errors.push('privacy and safety configuration is incomplete');
  if (!config.providerConfigured) errors.push('the tutor provider is not configured');
  if (env.NOURA_STORAGE_ADAPTER !== 'postgres') errors.push('Production must use the Postgres storage adapter');
  errors.push('Production Postgres domain adapter wiring has not passed the application contract gate');
  if (env.NOURA_UNDER_13_MODE === 'enabled' && !env.NOURA_ZDR_EVIDENCE_REFERENCE) {
    errors.push('under-13 mode requires externally verified ZDR evidence');
  }
  return errors;
}
