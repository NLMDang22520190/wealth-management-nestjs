import type { CoreBanking, CoreCustomer } from '../modules/customer-risk/onboarding.domain.js';

// Explicitly synthetic local fixtures: these references never contact a bank or represent real customers.
// CIF100001-CIF100005 mirror the team demo seed (names, birth dates, CASA numbers used as the VND account id);
// CIF100006-CIF100009 are extra synthetic customers for UC-01 demos (eligible, blacklisted, credit group 3, minor).
const customer = (cifId: string, name: string, dateOfBirth: string, accountId: string, extra: Partial<CoreCustomer> = {}): CoreCustomer => ({
  cifId, name, dateOfBirth, active: true, kycVerified: true,
  accounts: [{ id: accountId, ownerCifId: cifId, currency: 'VND', active: true }], ...extra,
});
const customers: CoreCustomer[] = [
  customer('CIF100001', 'Nguyễn Thị Mai', '1968-03-12', '0011000123451'),
  customer('CIF100002', 'Trần Quốc Huy', '1985-07-25', '0011000123452'),
  customer('CIF100003', 'Võ Thanh Tâm', '1990-11-02', '0011000123453'),
  customer('CIF100004', 'Đặng Hải Yến', '1979-01-30', '0011000123454'),
  customer('CIF100005', 'Bùi Gia Khánh', '1982-09-09', '0011000123455'),
  customer('CIF100006', 'Phan Minh Quân', '1991-04-18', '0011000123456'),
  customer('CIF100007', 'Lý Hoàng Nam (danh sách đen)', '1988-03-10', '0011000123457', { blacklisted: true, creditGroup: 1 }),
  customer('CIF100008', 'Đỗ Thu Trang (nhóm nợ 3)', '1985-11-25', '0011000123458', { blacklisted: false, creditGroup: 3 }),
  customer('CIF100009', 'Ngô Bảo Châu (dưới 18 tuổi)', '2012-08-05', '0011000123459'),
];
const references = new Map<string, CoreCustomer>(customers.map(item => [item.cifId, item]));

/** Wired by main only when development/test explicitly enables mocks. Unknown references remain unknown. */
export const demoCoreBanking: CoreBanking = {
  async lookup(reference) {
    const found = references.get(reference);
    return found ? structuredClone(found) : null;
  },
};
