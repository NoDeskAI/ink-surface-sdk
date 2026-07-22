import { describe, expect, it } from 'vitest';
import { authorizedZoomHostUserIds } from './zoom-host-access';

describe('Zoom host access mapping', () => {
  const env = {
    INKLOOP_ZOOM_HOST_ACCESS_JSON: JSON.stringify([
      { tenant_id: 'tenant-a', user_id: 'ada', host_user_ids: ['ada@example.com', 'zoom-ada'] },
      { tenant_id: 'tenant-a', user_id: 'bob', host_user_ids: ['zoom-bob'] },
      { tenant_id: 'tenant-b', user_id: 'ada', host_user_ids: ['other-ada'] },
    ]),
  };

  it('returns only the exact tenant/user host allow-list', () => {
    expect(authorizedZoomHostUserIds({ tenant_id: 'tenant-a', user_id: 'ada' }, env))
      .toEqual(['ada@example.com', 'zoom-ada']);
    expect(authorizedZoomHostUserIds({ tenant_id: 'tenant-a', user_id: 'bob' }, env))
      .toEqual(['zoom-bob']);
    expect(authorizedZoomHostUserIds({ tenant_id: 'tenant-b', user_id: 'ada' }, env))
      .toEqual(['other-ada']);
  });

  it('fails closed for missing identities, malformed JSON, and incomplete entries', () => {
    expect(authorizedZoomHostUserIds({}, env)).toEqual([]);
    expect(authorizedZoomHostUserIds({ tenant_id: 'tenant-a', user_id: 'mallory' }, env)).toEqual([]);
    expect(authorizedZoomHostUserIds({ tenant_id: 'tenant-a', user_id: 'ada' }, {
      INKLOOP_ZOOM_HOST_ACCESS_JSON: '{invalid',
    })).toEqual([]);
    expect(authorizedZoomHostUserIds({ tenant_id: 'tenant-a', user_id: 'ada' }, {
      INKLOOP_ZOOM_HOST_ACCESS_JSON: JSON.stringify([{ tenant_id: 'tenant-a', user_id: 'ada' }]),
    })).toEqual([]);
  });
});
