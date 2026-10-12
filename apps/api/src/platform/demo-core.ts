import type { CoreBanking, CoreCustomer } from '../modules/customer-risk/onboarding.domain.js';

// Explicitly synthetic local fixtures: these references never contact a bank or represent real customers.
const customers: CoreCustomer[] = [
  {
    cifId: '00000101', name: 'Khách hàng demo Alpha', dateOfBirth: '1990-01-15',
    active: true, kycVerified: true,
    accounts: [{ id: 'synthetic-vnd-account-101', ownerCifId: '00000101', currency: 'VND', active: true }],
  },
  {
    cifId: '00000102', name: 'Khách hàng demo Beta', dateOfBirth: '1992-06-20',
    active: true, kycVerified: true,
    accounts: [{ id: 'synthetic-vnd-account-102', ownerCifId: '00000102', currency: 'VND', active: true }],
  },
];
const references = new Map<string, CoreCustomer>([
  [customers[0].cifId, customers[0]], ['synthetic-identity-reference-101', customers[0]],
  [customers[1].cifId, customers[1]], ['synthetic-identity-reference-102', customers[1]],
]);

/** Wired by main only when development/test explicitly enables mocks. Unknown references remain unknown. */
export const demoCoreBanking: CoreBanking = {
  async lookup(reference) {
    const customer = references.get(reference);
    return customer ? structuredClone(customer) : null;
  },
};
