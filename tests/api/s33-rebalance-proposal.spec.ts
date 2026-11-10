import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors, insertStaff, staff, viaDataSource } from '../helpers/actors.js';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { activeCustomer, audit, fund, nextKey } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { alerts, RM, runSnapshot, staffTokens } from '../helpers/portfolio.js';

const EVENT = 'RebalanceProposalRequested';
const ACTION = 'DRIFT_ALERT_ACTIONED';

/** UC-12 step 5 (spec: "RM chọn Tạo đề xuất tái cân bằng ... DriftAlert.status chuyển thành ACTIONED"); P3 owns the status and the event, P4 (UC-13) consumes the event later. */
describe('S33 UC-12 rebalance proposal request', () => {
  let api: Api;
  let backOffice: string;
  let customerId: string;
  let rm: string;
  let alertId: string;
  beforeEach(async () => {
    api = await startApiFixture();
    customerId = (await activeCustomer(api)).customerId;
    ({ backOffice } = await staffTokens(api));
    // 10,000,000 cash only: every class is far from the BALANCED target 5/30/30/35, so there are four alerts.
    await fund(api, '10000000');
    expect((await runSnapshot(api, backOffice)).status).toBe(200);
    rm = await api.tokenFor(RM);
    const list = await api.request('/rm/drift-alerts', { token: rm });
    alertId = list.body.items.find((item: { allocationClass: string }) => item.allocationClass === 'CASH').alertId;
  }, 120_000);
  afterEach(async () => { await api?.stop(); });

  const propose = (id = alertId, token = rm, key: string | undefined = nextKey('rebalance')) =>
    api.request(`/rm/drift-alerts/${id}/rebalance-proposal`, { method: 'POST', token, ...(key ? { key } : {}) });
  const events = (type = EVENT) => api.dataSource.query('SELECT event_type,aggregate_type,aggregate_id::text,payload,published_at FROM wms.outbox_events WHERE event_type=$1 ORDER BY created_at', [type]);
  const statusOf = async (id = alertId) => (await api.dataSource.query('SELECT status::text AS status,actioned_at FROM wms.drift_alerts WHERE alert_id=$1', [id]))[0] as { status: string; actioned_at: Date | null };

  test('the RM of the customer sets ACTIONED, with one outbox event for P4 and one audit row, in one transaction', async () => {
    const response = await propose();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ alertId, customerId, allocationClass: 'CASH', status: 'ACTIONED', actionedAt: expect.any(String), direction: 'DECREASE', adjustAmount: '9500000.00' }));
    expect(await statusOf()).toEqual({ status: 'ACTIONED', actioned_at: expect.any(Date) });
    const riskProfileId = (await api.dataSource.query('SELECT current_risk_profile_id FROM wms.wealth_services WHERE customer_id=$1', [customerId]))[0].current_risk_profile_id;
    expect(await events()).toEqual([{ event_type: EVENT, aggregate_type: 'DRIFT_ALERT', aggregate_id: alertId, published_at: null,
      payload: { alertId, customerId, rmId: actors.rm.rmId, riskProfileId, allocationClass: 'CASH', actualWeight: '100.00', targetWeight: '5.00',
        suggestions: [{ allocationClass: 'CASH', direction: 'DECREASE', adjustAmount: '9500000.00' }] } }]);
    expect(await audit(api, ACTION)).toEqual([expect.objectContaining({ actor_id: RM, actor_role: 'RM', outcome: 'SUCCESS', reference_type: 'DRIFT_ALERT', reference_id: alertId,
      old_value: { status: 'NEW' }, new_value: { status: 'ACTIONED' } })]);
    // The open list no longer shows it, and the other alerts are untouched.
    const open = (await api.request('/rm/drift-alerts', { token: rm })).body.items.map((item: { allocationClass: string }) => item.allocationClass);
    expect(open).not.toContain('CASH');
    expect(open).toHaveLength(3);
  });

  test('a READ alert can be actioned too', async () => {
    expect((await api.request(`/rm/drift-alerts/${alertId}/read`, { method: 'POST', token: rm, key: nextKey('read') })).body.status).toBe('READ');
    expect((await propose()).body.status).toBe('ACTIONED');
  });

  test('a replay with the same key returns the stored result and adds no second event or audit row; the key is required', async () => {
    const key = nextKey('rebalance');
    const first = await propose(alertId, rm, key);
    const again = await propose(alertId, rm, key);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await events()).toHaveLength(1);
    expect(await audit(api, ACTION)).toHaveLength(1);
    const other = (await api.request('/rm/drift-alerts', { token: rm })).body.items[0].alertId;
    expectApiError(await propose(other, rm, undefined), 400, 'VALIDATION_ERROR');
    expect((await statusOf(other)).status).toBe('NEW');
  });

  test('an alert that is already ACTIONED or RESOLVED is 409 ALERT_NOT_OPEN and writes nothing; an unknown alert is 404', async () => {
    expect((await propose()).status).toBe(200);
    expectApiError(await propose(alertId, rm, nextKey('rebalance')), 409, 'ALERT_NOT_OPEN');
    const [resolved] = (await api.request('/rm/drift-alerts', { token: rm })).body.items;
    await api.dataSource.query("UPDATE wms.drift_alerts SET status='RESOLVED' WHERE alert_id=$1", [resolved.alertId]);
    expectApiError(await propose(resolved.alertId), 409, 'ALERT_NOT_OPEN');
    expect(await events()).toHaveLength(1);
    expect(await audit(api, ACTION)).toHaveLength(1);
    expectApiError(await propose('00000000-0000-4000-8000-000000000000'), 404, 'ALERT_NOT_FOUND');
  });

  test('scope: another RM is 403 and audited DENIED; leader, back-office and customer are 403; the alert stays open', async () => {
    await insertStaff(viaDataSource(api.dataSource), staff.foreign);
    expectApiError(await propose(alertId, await api.tokenFor(staff.foreign.actorId)), 403, 'FORBIDDEN');
    expect(await audit(api, ACTION)).toEqual([expect.objectContaining({ actor_id: staff.foreign.actorId, outcome: 'DENIED', reference_id: alertId })]);
    for (const token of [await api.tokenFor(actors.leader.actorId), backOffice, await api.tokenFor(actors.customer.actorId)]) expectApiError(await propose(alertId, token), 403, 'FORBIDDEN');
    expect((await statusOf()).status).toBe('NEW');
    expect(await events()).toEqual([]);
  });

  test('ACTIONED is left alone by the next scan: no new alert for the class', async () => {
    await propose();
    api.tick();
    await fund(api, '1000000');
    expect((await runSnapshot(api, backOffice, '2026-01-16')).status).toBe(200);
    expect((await alerts(api)).filter(row => row.class === 'CASH').map(row => row.status)).toEqual(['ACTIONED']);
  });

  test('it is one transaction: when the outbox insert fails, the alert stays open and no audit row is kept', async () => {
    await api.dataSource.query(`CREATE FUNCTION wms.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
      CREATE TRIGGER test_fail BEFORE INSERT ON wms.outbox_events FOR EACH ROW WHEN (NEW.event_type='${EVENT}') EXECUTE FUNCTION wms.test_fail()`);
    expect((await propose()).status).toBe(500);
    expect((await statusOf()).status).toBe('NEW');
    expect(await audit(api, ACTION)).toEqual([]);
    await api.dataSource.query('DROP TRIGGER test_fail ON wms.outbox_events');
    expect((await propose()).status).toBe(200);
  });
});
