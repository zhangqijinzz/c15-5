import { describe, expect, it } from 'vitest';
import { exampleScenario, summarizeScenario } from '../domain';
import {
  parseTransferText,
  planImport,
  serializeTransfer,
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  transferFileName,
  type TransferEnvelope,
} from '../services/transferService';
import type { EnergyDocument, EnergyScenario } from '../types';

const fixedNow = () => 1700000000000;

const officeScenario: EnergyScenario = {
  id: 'scenario-office',
  name: '工作室方案',
  pricePerKwh: 0.85,
  daysPerMonth: 22,
  createdAt: '2026-02-01T00:00:00.000Z',
  devices: [
    { id: 'device-pc', name: '电脑', watts: 350, dailyHours: 8 },
    { id: 'device-heater', name: '电暖器', watts: 2000, dailyHours: 3 },
  ],
};

function makeDocument(scenarios: EnergyScenario[]): EnergyDocument {
  return { version: 1, scenarios, activeScenarioId: scenarios[0].id };
}

function envelopeWith(scenarios: unknown[]): TransferEnvelope {
  return { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, exportedAt: '2026-09-27T00:00:00.000Z', scenarios };
}

function parseOk(text: string): TransferEnvelope {
  const result = parseTransferText(text);
  if (!result.ok) throw new Error(`expected parse to succeed, got: ${result.message}`);
  return result.envelope;
}

function importableScenarios(envelope: TransferEnvelope, existing: EnergyScenario[] = []): EnergyScenario[] {
  return planImport(envelope, existing, fixedNow).entries.flatMap((entry) => (entry.scenario ? [entry.scenario] : []));
}

describe('transfer export', () => {
  it('round-trips scenarios with full fidelity and identical conclusions', () => {
    const document = makeDocument([structuredClone(exampleScenario), structuredClone(officeScenario)]);
    const text = serializeTransfer(document, new Date('2026-09-27T08:00:00.000Z'));
    const plan = planImport(parseOk(text), [], fixedNow);

    expect(plan.skippedCount).toBe(0);
    expect(plan.entries.every((entry) => entry.status === 'ready' && entry.notes.length === 0)).toBe(true);
    const restored = plan.entries.map((entry) => entry.scenario);
    expect(restored).toEqual(document.scenarios);
    restored.forEach((scenario, index) => {
      expect(summarizeScenario(scenario!)).toEqual(summarizeScenario(document.scenarios[index]));
    });
  });

  it('produces a stable, dated file name', () => {
    expect(transferFileName(new Date(2026, 8, 27, 9, 5, 3))).toBe('energy-lens-backup-20260927-090503.json');
  });
});

describe('transfer parsing', () => {
  it('tolerates pasted text with junk around the JSON payload', () => {
    const text = serializeTransfer(makeDocument([structuredClone(exampleScenario)]));
    const envelope = parseOk(`备份内容如下：\n${text}\n—— 导出结束 ——`);
    expect(envelope.scenarios).toHaveLength(1);
  });

  it('rejects empty, non-JSON and non-envelope content with clear messages', () => {
    const empty = parseTransferText('   ');
    const garbage = parseTransferText('这不是 JSON');
    const array = parseTransferText('[1, 2, 3]');
    const other = parseTransferText('{"format": "some-other-app", "version": 1}');
    for (const result of [empty, garbage, array, other]) {
      expect(result.ok).toBe(false);
    }
    if (!empty.ok) expect(empty.message).toContain('内容为空');
    if (!garbage.ok) expect(garbage.message).toContain('无法识别');
    if (!other.ok) expect(other.message).toContain('不是 EnergyLens 导出');
  });

  it('rejects a raw local-storage document with a specific message', () => {
    const rawStorage = JSON.stringify(makeDocument([structuredClone(exampleScenario)]));
    const result = parseTransferText(rawStorage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('本地存档');
  });

  it('rejects data from newer or unknown versions explicitly', () => {
    const newer = parseTransferText(JSON.stringify({ format: TRANSFER_FORMAT, version: TRANSFER_VERSION + 1, scenarios: [exampleScenario] }));
    const ancient = parseTransferText(JSON.stringify({ format: TRANSFER_FORMAT, version: 0, scenarios: [exampleScenario] }));
    const noVersion = parseTransferText(JSON.stringify({ format: TRANSFER_FORMAT, scenarios: [exampleScenario] }));
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.message).toContain('更新的版本');
    expect(ancient.ok).toBe(false);
    expect(noVersion.ok).toBe(false);
    if (!noVersion.ok) expect(noVersion.message).toContain('版本号');
  });

  it('rejects an envelope without scenarios', () => {
    const result = parseTransferText(JSON.stringify({ format: TRANSFER_FORMAT, version: TRANSFER_VERSION, scenarios: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('没有可导入的方案');
  });
});

describe('import planning', () => {
  it('skips scenarios with missing billing parameters without affecting the rest', () => {
    const noPrice = { id: 's1', name: '缺电价', daysPerMonth: 30, devices: [{ id: 'd1', name: '灯', watts: 10, dailyHours: 2 }] };
    const badDays = { id: 's2', name: '天数超限', pricePerKwh: 0.5, daysPerMonth: 45, devices: [{ id: 'd2', name: '灯', watts: 10, dailyHours: 2 }] };
    const noDevices = { id: 's3', name: '没设备', pricePerKwh: 0.5, daysPerMonth: 30 };
    const plan = planImport(envelopeWith([noPrice, badDays, noDevices, structuredClone(exampleScenario), null]), [], fixedNow);

    expect(plan.entries).toHaveLength(5);
    expect(plan.importableCount).toBe(1);
    expect(plan.skippedCount).toBe(4);
    expect(plan.entries[0].notes[0]).toContain('电价');
    expect(plan.entries[1].notes[0]).toContain('计费天数');
    expect(plan.entries[2].notes[0]).toContain('设备清单');
    expect(plan.entries[4].notes[0]).toContain('损坏');
    expect(plan.entries[3].scenario?.id).toBe(exampleScenario.id);
  });

  it('drops broken devices but keeps the rest of the scenario', () => {
    const scenario = {
      id: 's1', name: '混合质量', pricePerKwh: 0.5, daysPerMonth: 30, createdAt: '2026-01-01',
      devices: [
        { id: 'd1', name: '正常', watts: 100, dailyHours: 2 },
        { id: 'd2', name: '负功率', watts: -5, dailyHours: 2 },
        { id: 'd3', name: '超时', watts: 100, dailyHours: 25 },
        'not-a-device',
      ],
    };
    const plan = planImport(envelopeWith([scenario]), [], fixedNow);
    const entry = plan.entries[0];

    expect(entry.status).toBe('adjusted');
    expect(entry.scenario?.devices).toHaveLength(1);
    expect(entry.scenario?.devices[0].name).toBe('正常');
    expect(entry.notes.join('\n')).toContain('功率缺失或无效');
    expect(entry.notes.join('\n')).toContain('0–24 小时');
    expect(entry.notes.join('\n')).toContain('数据损坏');
  });

  it('skips a scenario when every device is unusable', () => {
    const scenario = { id: 's1', name: '全坏', pricePerKwh: 0.5, daysPerMonth: 30, devices: [{ id: 'd1', name: 'x', watts: -1, dailyHours: 1 }] };
    const plan = planImport(envelopeWith([scenario]), [], fixedNow);
    expect(plan.entries[0].status).toBe('skipped');
    expect(plan.entries[0].notes.join('\n')).toContain('没有可用的设备数据');
  });

  it('repairs missing secondary fields and reports each fix', () => {
    const scenario = { pricePerKwh: 0.5, daysPerMonth: 30, devices: [{ watts: 100, dailyHours: 2 }] };
    const plan = planImport(envelopeWith([scenario]), [], fixedNow);
    const entry = plan.entries[0];

    expect(entry.status).toBe('adjusted');
    expect(entry.scenario?.name).toBe('未命名方案');
    expect(entry.scenario?.id).toMatch(/^scenario-import-/);
    expect(entry.scenario?.createdAt).toBe(new Date(fixedNow()).toISOString());
    expect(entry.scenario?.devices[0].name).toBe('未命名设备');
    expect(entry.scenario?.devices[0].id).toMatch(/^device-import-/);
    expect(entry.notes.join('\n')).toContain('缺少名称');
    expect(entry.notes.join('\n')).toContain('缺少编号');
    expect(entry.notes.join('\n')).toContain('创建时间');
  });

  it('renames on name collision and never touches the existing scenario', () => {
    const existing = [structuredClone(exampleScenario)];
    const imported = structuredClone(exampleScenario);
    imported.id = 'scenario-other';
    const plan = planImport(envelopeWith([imported, structuredClone(imported)]), existing, fixedNow);

    expect(plan.entries[0].scenario?.name).toBe('夏日居家方案 · 导入');
    expect(plan.entries[1].scenario?.name).toBe('夏日居家方案 · 导入 2');
    expect(plan.entries[0].notes.join('\n')).toContain('重名');
    expect(existing[0].name).toBe('夏日居家方案');
  });

  it('reassigns colliding scenario ids and keeps existing data intact', () => {
    const existing = [structuredClone(exampleScenario)];
    const plan = planImport(envelopeWith([structuredClone(exampleScenario), structuredClone(exampleScenario)]), existing, fixedNow);
    const [first, second] = plan.entries;

    expect(first.scenario?.id).not.toBe(exampleScenario.id);
    expect(second.scenario?.id).not.toBe(exampleScenario.id);
    expect(first.scenario?.id).not.toBe(second.scenario?.id);
    expect(first.notes.join('\n')).toContain('编号');
    expect(existing[0]).toEqual(exampleScenario);
    expect(summarizeScenario(first.scenario!)).toEqual(summarizeScenario(exampleScenario));
  });

  it('reassigns duplicated device ids within one scenario', () => {
    const scenario = {
      id: 's1', name: '重复编号', pricePerKwh: 0.5, daysPerMonth: 30, createdAt: '2026-01-01',
      devices: [
        { id: 'd1', name: '甲', watts: 100, dailyHours: 1 },
        { id: 'd1', name: '乙', watts: 200, dailyHours: 2 },
      ],
    };
    const plan = planImport(envelopeWith([scenario]), [], fixedNow);
    const devices = plan.entries[0].scenario?.devices ?? [];

    expect(devices).toHaveLength(2);
    expect(devices[0].id).toBe('d1');
    expect(devices[1].id).not.toBe('d1');
    expect(plan.entries[0].notes.join('\n')).toContain('编号与同方案其它设备重复');
  });

  it('ignores unknown extra fields from newer minor versions', () => {
    const scenario = {
      ...structuredClone(exampleScenario),
      futureField: { nested: true },
      devices: [{ id: 'd1', name: '灯', watts: 10, dailyHours: 2, extraFlag: 1 }],
    };
    const envelope = { ...envelopeWith([scenario]), futureEnvelopeField: 'x' };
    const plan = planImport(envelope, [], fixedNow);
    const restored = plan.entries[0].scenario;

    expect(plan.entries[0].status).toBe('ready');
    expect(restored && 'futureField' in restored).toBe(false);
    expect(restored?.devices[0] && 'extraFlag' in restored.devices[0]).toBe(false);
    expect(restored?.devices[0]).toEqual({ id: 'd1', name: '灯', watts: 10, dailyHours: 2 });
  });

  it('keeps conclusions identical when imported alongside existing scenarios', () => {
    const existing = [structuredClone(exampleScenario)];
    const exported = makeDocument([structuredClone(officeScenario)]);
    const restored = importableScenarios(parseOk(serializeTransfer(exported)), existing);
    const merged = [...existing, ...restored];

    expect(merged).toHaveLength(2);
    expect(summarizeScenario(merged[0])).toEqual(summarizeScenario(exampleScenario));
    expect(summarizeScenario(merged[1])).toEqual(summarizeScenario(officeScenario));
  });
});
