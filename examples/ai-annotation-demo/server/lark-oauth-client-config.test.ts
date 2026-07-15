import { describe, expect, it } from 'vitest';
import {
  buildLarkOAuthAuthorizeUrl,
  DEFAULT_LARK_OAUTH_AUTHORIZE_URL,
  resolveLarkOAuthAuthorizeUrl,
  withLarkOAuthAuthorizeUrl,
} from './lark-oauth-client-config';

describe('lark oauth client config', () => {
  it('forces the tracked Feishu authorize endpoint for vendor clients by default', () => {
    const clientEnv = withLarkOAuthAuthorizeUrl({ LARK_APP_ID: 'cli_test' });

    expect(resolveLarkOAuthAuthorizeUrl({})).toBe(DEFAULT_LARK_OAUTH_AUTHORIZE_URL);
    expect(clientEnv).toMatchObject({
      LARK_OAUTH_AUTHORIZE_URL: DEFAULT_LARK_OAUTH_AUTHORIZE_URL,
      LARK_OAUTH_AUTHORIZE_PATH: DEFAULT_LARK_OAUTH_AUTHORIZE_URL,
    });
    expect(new URL(clientEnv.LARK_OAUTH_AUTHORIZE_PATH).hostname).toBe('accounts.feishu.cn');
    expect(new URL(clientEnv.LARK_OAUTH_AUTHORIZE_PATH).pathname).toBe('/open-apis/authen/v1/authorize');

    const authorizeUrl = new URL(buildLarkOAuthAuthorizeUrl(clientEnv, {
      clientId: 'cli_test',
      redirectUri: 'http://localhost:8731/api/feishu/callback',
      state: 'state_test',
      scope: 'offline_access vc:note:read',
    }));
    expect(authorizeUrl.searchParams.get('client_id')).toBe('cli_test');
    expect(authorizeUrl.searchParams.has('app_id')).toBe(false);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:8731/api/feishu/callback');
    expect(authorizeUrl.searchParams.get('state')).toBe('state_test');
    expect(authorizeUrl.searchParams.get('scope')).toBe('offline_access vc:note:read');
  });

  it('allows an environment override while preserving the legacy vendor key', () => {
    const override = 'https://oauth.example.test/custom/authorize';
    const clientEnv = withLarkOAuthAuthorizeUrl({ LARK_OAUTH_AUTHORIZE_URL: ` ${override} ` });

    expect(clientEnv.LARK_OAUTH_AUTHORIZE_URL).toBe(override);
    expect(clientEnv.LARK_OAUTH_AUTHORIZE_PATH).toBe(override);
  });
});
