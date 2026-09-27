// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { exampleScenario } from '../domain';
import { LocalEnergyRepository } from '../repository';
import type { EnergyDocument } from '../types';

describe('local persistence recovery', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to a valid example when saved JSON is damaged', () => {
    localStorage.setItem('energy-lens.document.v1', JSON.stringify({ version: 1, scenarios: [null], activeScenarioId: 'missing' }));
    const recovered = new LocalEnergyRepository().load();
    expect(recovered.activeScenarioId).toBe(exampleScenario.id);
    expect(recovered.scenarios[0].devices.length).toBeGreaterThan(0);
  });

  it('opens documents saved before the transfer feature existed', () => {
    const legacy: EnergyDocument = { version: 1, scenarios: [structuredClone(exampleScenario)], activeScenarioId: exampleScenario.id };
    localStorage.setItem('energy-lens.document.v1', JSON.stringify(legacy));
    expect(new LocalEnergyRepository().load()).toEqual(legacy);
  });
});
