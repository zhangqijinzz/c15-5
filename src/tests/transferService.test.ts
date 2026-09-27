import { describe, expect, it } from 'vitest';
import { exampleScenario, summarizeScenario } from '../domain';
import { EXPORT_KIND, EXPORT_VERSION, importScenarios, serializeScenarios } from '../services/transferService';
import type { EnergyDocument, EnergyScenario } from '../types';

const NOW = new Date('2026-09-27T08:00:00.000Z');

function makeDocument(scenarios: EnergyScenario[] = []): EnergyDocument {
  return { version: 1, scenarios, activeScenarioId: scenarios[0]?.id ?? '' };
}

function exportWith(scenarios: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: EXPORT_KIND, version: EXPORT_VERSION, exportedAt: NOW.toISOString(), scenarios, ...extra });
}

describe('transferService round trip', () => {
  it('restores devices and billing parameters so results match exactly', () => {
    const source = structuredClone(exampleScenario);
    const text = serializeScenarios([source], NOW);
    const result = importScenarios(makeDocument(), text, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.scenarios).toHaveLength(1);
    expect(result.document.scenarios[0]).toEqual(source);
    expect(summarizeScenario(result.document.scenarios[0])).toEqual(summarizeScenario(source));
    expect(result.entries[0]).toMatchObject({ outcome: 'imported', sourceName: source.name });
  });

  it('keeps existing scenarios untouched and activates the first imported one', () => {
    const existing = structuredClone(exampleScenario);
    const incoming: EnergyScenario = { ...structuredClone(exampleScenario), id: 'scenario-office', name: '办公室方案' };
    const document = makeDocument([existing]);
    const result = importScenarios(document, serializeScenarios([incoming], NOW), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.scenarios).toHaveLength(2);
    expect(result.document.scenarios[0]).toBe(existing);
    expect(result.document.scenarios[1]).toEqual(incoming);
    expect(result.document.activeScenarioId).toBe('scenario-office');
  });
});

describe('transferService rejects unusable content as a whole', () => {
  const document = makeDocument([structuredClone(exampleScenario)]);

  it('rejects empty content', () => {
    const result = importScenarios(document, '   ');
    expect(result.ok).toBe(false);
    expect(result.entries).toHaveLength(0);
  });

  it('rejects broken JSON', () => {
    const result = importScenarios(document, '{"kind": "energy-lens');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('JSON');
  });

  it('rejects content that is not an EnergyLens export', () => {
    const result = importScenarios(document, JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('不是 EnergyLens');
  });

  it('rejects exports from other versions explicitly', () => {
    const result = importScenarios(document, exportWith([structuredClone(exampleScenario)], { version: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('版本');
    expect(document.scenarios).toHaveLength(1);
  });

  it('rejects an export without scenarios', () => {
    const result = importScenarios(document, exportWith([]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('没有任何方案');
  });
});

describe('transferService isolates per-scenario problems', () => {
  it('skips scenarios with missing billing fields but imports the healthy ones', () => {
    const healthy: EnergyScenario = { ...structuredClone(exampleScenario), id: 'scenario-good', name: '完好方案' };
    const broken = { id: 'scenario-broken', name: '缺电价方案', daysPerMonth: 30, createdAt: NOW.toISOString(), devices: [{ id: 'd1', name: '灯', watts: 10, dailyHours: 2 }] };
    const result = importScenarios(makeDocument(), exportWith([broken, healthy]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.scenarios).toHaveLength(1);
    expect(result.document.scenarios[0].id).toBe('scenario-good');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ outcome: 'skipped', sourceName: '缺电价方案' });
    expect(result.entries[0].notes[0]).toContain('电价');
    expect(result.entries[1]).toMatchObject({ outcome: 'imported', sourceName: '完好方案' });
  });

  it('skips non-object entries without failing the rest', () => {
    const healthy: EnergyScenario = { ...structuredClone(exampleScenario), id: 'scenario-good', name: '完好方案' };
    const result = importScenarios(makeDocument(), exportWith([null, 42, healthy]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.scenarios).toHaveLength(1);
    expect(result.entries.filter((entry) => entry.outcome === 'skipped')).toHaveLength(2);
  });

  it('drops invalid devices but keeps the valid ones with a note', () => {
    const scenario = {
      ...structuredClone(exampleScenario),
      devices: [
        { id: 'device-ok', name: '冰箱', watts: 150, dailyHours: 10 },
        { id: 'device-bad', name: '坏设备', watts: -5, dailyHours: 2 },
        { id: 'device-bad2', name: '超时设备', watts: 10, dailyHours: 25 },
      ],
    };
    const result = importScenarios(makeDocument(), exportWith([scenario]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const imported = result.document.scenarios[0];
    expect(imported.devices).toHaveLength(1);
    expect(imported.devices[0].name).toBe('冰箱');
    expect(result.entries[0].notes.join('')).toContain('第 2 台设备数据无效');
    expect(result.entries[0].notes.join('')).toContain('第 3 台设备数据无效');
  });

  it('skips a scenario whose devices are all invalid', () => {
    const scenario = { ...structuredClone(exampleScenario), devices: [{ id: 'x', name: '坏', watts: -1, dailyHours: 1 }] };
    const result = importScenarios(makeDocument(), exportWith([scenario]), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('没有可导入的方案');
    expect(result.entries[0].outcome).toBe('skipped');
    expect(result.entries[0].notes[0]).toContain('没有有效设备');
  });
});

describe('transferService resolves conflicts without overwriting', () => {
  it('renames imported scenarios that collide with an existing name', () => {
    const existing = structuredClone(exampleScenario);
    const incoming: EnergyScenario = { ...structuredClone(exampleScenario), id: 'scenario-other' };
    const result = importScenarios(makeDocument([existing]), exportWith([incoming]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.scenarios).toHaveLength(2);
    expect(result.document.scenarios[0].name).toBe(exampleScenario.name);
    expect(result.document.scenarios[1].name).toBe(`${exampleScenario.name}（导入）`);
    expect(result.entries[0].notes.join('')).toContain('重名');
  });

  it('mints a new id when the internal id collides and remaps device ids', () => {
    const existing = structuredClone(exampleScenario);
    const incoming = structuredClone(exampleScenario);
    const result = importScenarios(makeDocument([existing]), exportWith([incoming]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [kept, imported] = result.document.scenarios;
    expect(kept).toBe(existing);
    expect(kept.id).toBe(exampleScenario.id);
    expect(imported.id).not.toBe(exampleScenario.id);
    expect(imported.id).toBeTruthy();
    imported.devices.forEach((device, index) => {
      expect(device.id).toBe(`${imported.id}-${exampleScenario.devices[index].id}`);
    });
    expect(result.entries[0].notes.join('')).toContain('重新分配');
    const stripIds = (summary: ReturnType<typeof summarizeScenario>) => ({
      total: summary.total,
      devices: summary.devices.map((device) => ({ name: device.name, watts: device.watts, dailyHours: device.dailyHours, monthlyKwh: device.monthlyKwh, monthlyCost: device.monthlyCost, share: device.share })),
    });
    expect(stripIds(summarizeScenario(imported))).toEqual(stripIds(summarizeScenario(existing)));
  });

  it('deduplicates device ids missing or repeated inside one scenario', () => {
    const scenario = {
      ...structuredClone(exampleScenario),
      id: 'scenario-dup',
      name: '编号重复方案',
      devices: [
        { id: 'device-a', name: '甲', watts: 100, dailyHours: 1 },
        { id: 'device-a', name: '乙', watts: 200, dailyHours: 1 },
        { name: '丙', watts: 300, dailyHours: 1 },
      ],
    };
    const result = importScenarios(makeDocument(), exportWith([scenario]), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.document.scenarios[0].devices.map((device) => device.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('never overwrites the existing document when everything is skipped', () => {
    const existing = structuredClone(exampleScenario);
    const document = makeDocument([existing]);
    const broken = { id: 'scenario-broken', name: '缺设备方案', pricePerKwh: 0.6, daysPerMonth: 30 };
    const result = importScenarios(document, exportWith([broken]), NOW);
    expect(result.ok).toBe(false);
    expect(document.scenarios).toEqual([existing]);
  });
});
