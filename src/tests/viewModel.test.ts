import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleScenario } from '../domain';
import type { EnergyDocument } from '../types';
import { EnergyLensViewModel } from '../viewModel';
import type { EnergyRepository } from '../repository';

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

  it('exports all scenarios as importable text', () => {
    const text = vm.exportText();
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text ?? '');
    expect(parsed.kind).toBe('energy-lens/export');
    expect(parsed.scenarios).toHaveLength(1);
    expect(parsed.scenarios[0].devices).toHaveLength(3);
  });

  it('imports its own export as a renamed copy without overwriting', () => {
    const text = vm.exportText() ?? '';
    vm.importFromText(text);
    expect(vm.getState().notice?.kind).toBe('success');
    const scenarios = vm.getState().document?.scenarios ?? [];
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0].id).toBe(exampleScenario.id);
    expect(scenarios[1].id).not.toBe(exampleScenario.id);
    expect(scenarios[1].name).toBe(`${exampleScenario.name}（导入）`);
    expect(vm.activeSummary?.total.monthlyKwh).toBeCloseTo(262.8);
    expect(vm.getState().transferEntries?.[0].outcome).toBe('imported');
    expect(repository.save).toHaveBeenCalled();
  });

  it('rejects broken import content without touching the document', () => {
    vm.importFromText('not a backup at all');
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().document?.scenarios).toHaveLength(1);
    expect(vm.getState().document?.scenarios[0].id).toBe(exampleScenario.id);
  });

  it('imports the healthy part of a partially damaged backup', () => {
    const healthy = { ...structuredClone(exampleScenario), id: 'scenario-new', name: '新方案' };
    const broken = { id: 'scenario-broken', name: '坏方案', devices: [] };
    const text = JSON.stringify({ kind: 'energy-lens/export', version: 1, exportedAt: '', scenarios: [broken, healthy] });
    vm.importFromText(text);
    expect(vm.getState().notice?.kind).toBe('success');
    expect(vm.getState().notice?.text).toContain('1 个因数据问题被跳过');
    expect(vm.getState().document?.scenarios.map((scenario) => scenario.id)).toEqual([exampleScenario.id, 'scenario-new']);
    expect(vm.getState().transferEntries?.map((entry) => entry.outcome)).toEqual(['skipped', 'imported']);
  });
});
