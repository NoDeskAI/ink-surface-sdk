export const DEFAULT_LARK_OAUTH_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';

function configuredValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveLarkOAuthAuthorizeUrl(env: Record<string, unknown>): string {
  return configuredValue(env.LARK_OAUTH_AUTHORIZE_URL)
    || configuredValue(env.FEISHU_OAUTH_AUTHORIZE_URL)
    || configuredValue(env.LARK_OAUTH_AUTHORIZE_PATH)
    || configuredValue(env.FEISHU_OAUTH_AUTHORIZE_PATH)
    || DEFAULT_LARK_OAUTH_AUTHORIZE_URL;
}

/** Keep both names so old and new vendor clients receive the tracked authorize endpoint. */
export function withLarkOAuthAuthorizeUrl<T extends Record<string, unknown>>(env: T): T & {
  LARK_OAUTH_AUTHORIZE_URL: string;
  LARK_OAUTH_AUTHORIZE_PATH: string;
} {
  const authorizeUrl = resolveLarkOAuthAuthorizeUrl(env);
  return {
    ...env,
    LARK_OAUTH_AUTHORIZE_URL: authorizeUrl,
    LARK_OAUTH_AUTHORIZE_PATH: authorizeUrl,
  };
}

export function buildLarkOAuthAuthorizeUrl(env: Record<string, unknown>, input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL(resolveLarkOAuthAuthorizeUrl(env));
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  if (input.scope) url.searchParams.set('scope', input.scope);
  return url.toString();
}
