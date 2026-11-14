/** Refuse to start in production with missing or weak secrets; a bad config should fail at boot, not at the first login. */
export function checkProductionConfig(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  const strong = (name: string) => {
    const v = env[name] ?? '';
    if (v.length < 32 || /change-me|long-random|another-long/.test(v)) problems.push(`${name} must be a random string of at least 32 characters`);
  };
  strong('JWT_SECRET');
  strong('TOKEN_ENCRYPTION_KEY');
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'PUBLIC_URL', 'WEB_URL']) if (!env[name]) problems.push(`${name} is not set`);
  if (problems.length) throw new Error(`Invalid production configuration:\n- ${problems.join('\n- ')}`);
}
