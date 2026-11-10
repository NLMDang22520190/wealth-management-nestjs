import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { BACK_OFFICE, insertBackOffice } from '../helpers/cash.js';

describe('S22 P2 back-office role', () => {
  let api: Awaited<ReturnType<typeof startApiFixture>>;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  test('BACK_OFFICE logs in and /auth/me exposes the role without RM or team scope', async () => {
    const token = await insertBackOffice(api);
    const me = await api.request('/auth/me', { token });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ actorId: BACK_OFFICE, subjectId: 'iam.bo', role: 'BACK_OFFICE', cifId: null, rmId: null, teamId: null });
  });

  test('BACK_OFFICE has no access to RM, leader or customer routes', async () => {
    const token = await insertBackOffice(api);
    for (const path of ['/rm/customers', '/team/rms', '/me/risk-profile']) expectApiError(await api.request(path, { token }), 403, 'FORBIDDEN');
  });
});
