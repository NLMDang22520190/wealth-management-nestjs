import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import type { Api } from '../helpers/cash.js';

/**
 * The team seed uses fixed ids such as c0000000-0000-0000-0000-000000000001 (version nibble 0). Path ids must accept them as body ids already do
 * (platform/validation.ts `uuid`), or every staff screen of a seeded customer answers 400.
 */
describe('S36 path ids accept the team seed id format', () => {
  let api: Api;
  beforeAll(async () => { api = await startApiFixture(); }, 120_000);
  afterAll(async () => { await api?.stop(); });

  const TEAM_ID = 'c0000000-0000-0000-0000-000000000001';

  test.each([
    `/customers/${TEAM_ID}`, `/customers/${TEAM_ID}/risk-profile`, `/customers/${TEAM_ID}/portfolio`, `/customers/${TEAM_ID}/proposals`,
    `/customers/${TEAM_ID}/cash-transactions`, `/customers/${TEAM_ID}/drift-alerts`, `/proposals/${TEAM_ID}`,
  ])('GET %s is not refused as malformed', async path => {
    const response = await api.request(path, { token: await api.tokenFor(actors.rm.actorId) });
    expect(response.status, JSON.stringify(response.body)).not.toBe(400);
  });

  test('a malformed id is still 400 VALIDATION_ERROR', async () => {
    expectApiError(await api.request('/customers/not-an-id', { token: await api.tokenFor(actors.rm.actorId) }), 400, 'VALIDATION_ERROR');
    expectApiError(await api.request('/proposals/c0000000-0000-0000-0000-00000000000g', { token: await api.tokenFor(actors.rm.actorId) }), 400, 'VALIDATION_ERROR');
  });
});
