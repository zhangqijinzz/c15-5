import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleScenario, summarizeScenario } from '../domain';
import type { EnergyDocument, EnergyScenario } from '../types';
import { EnergyLensViewModel } from '../viewModel';
import type { EnergyRepository } from '../repository';
import { parseTransferText, planImport, serializeTransfer } from '../services/transferService';

function makeRepository(): EnergyRepository & { data: EnergyDocument; save: ReturnType<typeof vi.fn> } {
  const data: EnergyDocument = { version: 1, scenarios: [structuredClone(exampleScenario)], activeScenarioId: exampleScenario.id };
  return { data, load: () => data, save: vi.fn((next: EnergyDocument) => { data.scenarios = next.scenarios; data.activeScenarioId = next.activeScenarioId; }) };
}

describe('EnergyLensViewModel', () => {
  let repository: ReturnType<typeof makeRepository>;
  let vm: EnergyLensViewModel;
  beforeEach(() => { repository = makeRepository(); vm = new EnergyLensViewModel(repository); vm.initialize(); });

  it('initializes, persists edits, and recalculates results', () => {
    expect(vm.getState().status).toBe('ready');
    const before = vm.activeSummary?.total.monthlyKwh;
    vm.updateDevice('device-aircon', { dailyHours: 2 });
    expect(vm.activeSummary?.total.monthlyKwh).toBeLessThan(before ?? Infinity);
    expect(repository.save).toHaveBeenCalled();
  });

  it('keeps invalid values out of the document and exposes an error notice', () => {
    vm.updateDevice('device-aircon', { watts: -50 });
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().notice?.text).toBe('功率不能为负数');
    expect(vm.activeScenario?.devices[0].watts).toBe(1200);
  });

  it('duplicates a scenario and can recover a saved document', () => {
    vm.duplicateActive();
    expect(vm.getState().document?.scenarios).toHaveLength(2);
    const recovered = new EnergyLensViewModel(repository);
    recovered.initialize();
    expect(recovered.getState().document?.scenarios).toHaveLength(2);
  });

  it('surfaces persistence failure as a recoverable error', () => {
    repository.save.mockImplementation(() => { throw new Error('quota'); });
    vm.addDevice();
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().notice?.text).toContain('保存失败');
  });

  it('appends imported scenarios without touching existing data', () => {
    const imported: EnergyScenario = { ...structuredClone(exampleScenario), id: 'scenario-imported', name: '导入的方案' };
    expect(vm.importScenarios([imported])).toBe(true);
    const document = vm.getState().document;
    expect(document?.scenarios).toHaveLength(2);
    expect(document?.scenarios[0]).toEqual(exampleScenario);
    expect(document?.activeScenarioId).toBe(exampleScenario.id);
    expect(repository.save).toHaveBeenCalled();
  });

  it('restores identical conclusions after a full export-import round trip', () => {
    const before = vm.activeSummary;
    const document = vm.getState().document;
    if (!document || !before) throw new Error('expected an initialized document');
    const parsed = parseTransferText(serializeTransfer(document));
    if (!parsed.ok) throw new Error('expected export to parse');
    const plan = planImport(parsed.envelope, document.scenarios);
    const imported = plan.entries.flatMap((entry) => (entry.scenario ? [entry.scenario] : []));
    vm.importScenarios(imported);
    const scenarios = vm.getState().document?.scenarios ?? [];
    expect(scenarios).toHaveLength(2);
    expect(summarizeScenario(scenarios[1])).toEqual(before);
    expect(summarizeScenario(scenarios[0])).toEqual(before);
  });

  it('rolls the import back when persistence fails', () => {
    repository.save.mockImplementation(() => { throw new Error('quota'); });
    const result = vm.importScenarios([{ ...structuredClone(exampleScenario), id: 'scenario-imported', name: 'x' }]);
    expect(result).toBe(false);
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().document?.scenarios).toHaveLength(1);
  });
});
