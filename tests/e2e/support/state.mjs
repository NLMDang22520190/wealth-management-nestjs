import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const stateDirectory = fileURLToPath(new URL('../../../test-results/e2e-state/', import.meta.url));
export const statePath = `${stateDirectory}state.json`;
export function ensureStateDirectory() { mkdirSync(stateDirectory, { recursive: true }); }
