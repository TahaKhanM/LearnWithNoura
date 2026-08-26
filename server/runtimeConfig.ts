export const EVENT_SCHEMA_VERSION = '1.0.0';
export const CANONICAL_ORIGIN = process.env.NOURA_CANONICAL_ORIGIN ?? 'https://learnwithnoura.com';

export type DeploymentMode = 'local-synthetic' | 'preview-synthetic' | 'production-v0' | 'production';

export interface RuntimeConfig {
  deploymentMode: DeploymentMode;
  production: boolean;
  v0: boolean;
  guestAccess: boolean;
  syntheticOnly: boolean;
  providerConfigured: boolean;
  durableStorageConfigured: boolean;
  authenticationConfigured: boolean;
  privacyConfigured: boolean;
  realtimeModel: string;
  textModel: string;
  compilerModel: string;
  compilerReasoningEffort: 'low' | 'medium' | 'high';
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
    : requested === 'production-v0'
      ? 'production-v0'
    : requested === 'preview-synthetic'
      ? 'preview-synthetic'
      : 'local-synthetic';
  const production = deploymentMode === 'production' || deploymentMode === 'production-v0';
  const v0 = deploymentMode === 'production-v0';

  return {
    deploymentMode,
    production,
    v0,
    guestAccess: v0,
    syntheticOnly: v0 || !production || env.NOURA_SYNTHETIC_ONLY !== 'false',
    providerConfigured: Boolean(env.OPENAI_API_KEY),
    durableStorageConfigured: Boolean(env.DATABASE_URL),
    authenticationConfigured: Boolean(env.NOURA_AUTH_SECRET && env.NOURA_AUTH_PROVIDER),
    privacyConfigured: Boolean(env.NOURA_PRIVACY_POLICY_VERSION && env.NOURA_SAFETY_MODE),
    realtimeModel: env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
    textModel: env.OPENAI_MODEL || 'gpt-5.6-terra',
    compilerModel: env.NOURA_COMPILER_MODEL || env.OPENAI_MODEL || 'gpt-5.6-terra',
    compilerReasoningEffort: env.NOURA_COMPILER_REASONING_EFFORT === 'low' || env.NOURA_COMPILER_REASONING_EFFORT === 'high'
      ? env.NOURA_COMPILER_REASONING_EFFORT
      : 'medium',
    buildSha: env.NOURA_BUILD_SHA || env.VERCEL_GIT_COMMIT_SHA || 'local-uncommitted',
    environment: env.VERCEL_ENV || deploymentMode,
  };
}

export function productionReadinessErrors(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!config.production) return [];
  const errors: string[] = [];
  if (!config.durableStorageConfigured) errors.push('durable managed storage is not configured');
  if (!config.providerConfigured) errors.push('the tutor provider is not configured');
  if (env.NOURA_STORAGE_ADAPTER !== 'postgres') errors.push('Production must use the Postgres storage adapter');
  if (!env.NOURA_LESSON_CAPABILITY_SECRET && !env.NOURA_AUTH_SECRET) errors.push('the lesson capability secret is not configured');
  if (config.v0) return errors;
  if (env.NOURA_DATABASE_SSL_REJECT_UNAUTHORIZED === 'false') errors.push('full Production requires verified database TLS');
  if (!config.authenticationConfigured) errors.push('parent authentication is not configured');
  if (!config.privacyConfigured) errors.push('privacy and safety configuration is incomplete');
  if (env.NOURA_UNDER_13_MODE === 'enabled' && !env.NOURA_ZDR_EVIDENCE_REFERENCE) {
    errors.push('under-13 mode requires externally verified ZDR evidence');
  }
  return errors;
}
