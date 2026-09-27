import type { EnergyDevice, EnergyDocument, EnergyScenario } from '../types';

export const EXPORT_KIND = 'energy-lens/export';
export const EXPORT_VERSION = 1;

export interface ExportPayload {
  kind: typeof EXPORT_KIND;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  scenarios: EnergyScenario[];
}

export interface TransferEntry {
  sourceName: string;
  outcome: 'imported' | 'skipped';
  notes: string[];
}

export type ImportResult =
  | { ok: true; document: EnergyDocument; entries: TransferEntry[] }
  | { ok: false; error: string; entries: TransferEntry[] };

export function serializeScenarios(scenarios: EnergyScenario[], exportedAt = new Date()): string {
  const payload: ExportPayload = {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    scenarios,
  };
  return JSON.stringify(payload, null, 2);
}

export function importScenarios(document: EnergyDocument, text: string, now = new Date()): ImportResult {
  const parsed = parseExportText(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, entries: [] };

  const usedIds = new Set(document.scenarios.map((scenario) => scenario.id));
  const usedNames = new Set(document.scenarios.map((scenario) => scenario.name));
  const imported: EnergyScenario[] = [];
  const entries: TransferEntry[] = [];

  parsed.scenarios.forEach((raw, index) => {
    const cleaned = cleanScenario(raw, now);
    if ('error' in cleaned) {
      entries.push({ sourceName: cleaned.sourceName, outcome: 'skipped', notes: [`第 ${index + 1} 个方案：${cleaned.error}`] });
      return;
    }
    const { scenario, notes } = cleaned;
    const sourceName = scenario.name;

    if (!scenario.id || usedIds.has(scenario.id)) {
      const nextId = mintId('scenario', usedIds, now);
      notes.push(scenario.id ? `内部编号「${scenario.id}」与已有方案冲突，已重新分配` : '原内容缺少内部编号，已重新分配');
      scenario.devices = scenario.devices.map((device) => ({ ...device, id: `${nextId}-${device.id}` }));
      scenario.id = nextId;
    }
    usedIds.add(scenario.id);

    const deviceIds = new Set<string>();
    scenario.devices = scenario.devices.map((device, deviceIndex) => {
      if (device.id && !deviceIds.has(device.id)) {
        deviceIds.add(device.id);
        return device;
      }
      const nextId = mintId(`device-${deviceIndex + 1}`, deviceIds, now);
      notes.push(`设备「${device.name}」的编号缺失或重复，已重新分配`);
      deviceIds.add(nextId);
      return { ...device, id: nextId };
    });

    if (usedNames.has(scenario.name)) {
      const nextName = uniqueName(scenario.name, usedNames);
      notes.push(`与已有方案重名，已改名为「${nextName}」`);
      scenario.name = nextName;
    }
    usedNames.add(scenario.name);

    imported.push(scenario);
    entries.push({ sourceName, outcome: 'imported', notes });
  });

  if (imported.length === 0) return { ok: false, error: '没有可导入的方案，本地数据未改动', entries };
  return {
    ok: true,
    document: { ...document, scenarios: [...document.scenarios, ...imported], activeScenarioId: imported[0].id },
    entries,
  };
}

function parseExportText(text: string): { ok: true; scenarios: unknown[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '内容为空，请粘贴导出的文本或选择备份文件' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: '内容不是有效的 JSON，可能复制不完整' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '内容结构不正确，不是一份 EnergyLens 备份' };
  }
  const candidate = parsed as Partial<ExportPayload>;
  if (candidate.kind !== EXPORT_KIND) return { ok: false, error: '内容不是 EnergyLens 导出的备份' };
  if (candidate.version !== EXPORT_VERSION) {
    return { ok: false, error: `备份来自不支持的版本（${String(candidate.version)}），当前仅支持版本 ${EXPORT_VERSION}，本地数据未改动` };
  }
  if (!Array.isArray(candidate.scenarios) || candidate.scenarios.length === 0) {
    return { ok: false, error: '备份里没有任何方案' };
  }
  return { ok: true, scenarios: candidate.scenarios };
}

type CleanedScenario = { scenario: EnergyScenario; notes: string[] } | { error: string; sourceName: string };

function cleanScenario(raw: unknown, now: Date): CleanedScenario {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '内容缺失或结构损坏', sourceName: '未知方案' };
  const candidate = raw as Partial<EnergyScenario>;
  const rawName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const sourceName = rawName || '未命名方案';

  if (typeof candidate.pricePerKwh !== 'number' || !Number.isFinite(candidate.pricePerKwh) || candidate.pricePerKwh < 0) {
    return { error: '电价缺失或无效', sourceName };
  }
  if (typeof candidate.daysPerMonth !== 'number' || !Number.isFinite(candidate.daysPerMonth) || candidate.daysPerMonth < 1 || candidate.daysPerMonth > 31) {
    return { error: '计费天数缺失或无效', sourceName };
  }
  if (!Array.isArray(candidate.devices)) return { error: '设备清单缺失', sourceName };

  const notes: string[] = [];
  const devices: EnergyDevice[] = [];
  candidate.devices.forEach((rawDevice, deviceIndex) => {
    const device = cleanDevice(rawDevice);
    if (device) devices.push(device);
    else notes.push(`第 ${deviceIndex + 1} 台设备数据无效，已忽略`);
  });
  if (devices.length === 0) return { error: '没有有效设备', sourceName };

  if (!rawName) notes.push('方案名称缺失，已使用默认名称');
  const createdAt = typeof candidate.createdAt === 'string' && candidate.createdAt ? candidate.createdAt : now.toISOString();
  if (typeof candidate.createdAt !== 'string' || !candidate.createdAt) notes.push('创建时间缺失，已按导入时间补齐');

  return {
    scenario: {
      id: typeof candidate.id === 'string' ? candidate.id : '',
      name: sourceName,
      pricePerKwh: candidate.pricePerKwh,
      daysPerMonth: candidate.daysPerMonth,
      createdAt,
      devices,
    },
    notes,
  };
}

function cleanDevice(raw: unknown): EnergyDevice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<EnergyDevice>;
  if (typeof candidate.name !== 'string') return null;
  if (typeof candidate.watts !== 'number' || !Number.isFinite(candidate.watts) || candidate.watts < 0) return null;
  if (typeof candidate.dailyHours !== 'number' || !Number.isFinite(candidate.dailyHours) || candidate.dailyHours < 0 || candidate.dailyHours > 24) return null;
  return {
    id: typeof candidate.id === 'string' ? candidate.id : '',
    name: candidate.name.trim() || '未命名设备',
    watts: candidate.watts,
    dailyHours: candidate.dailyHours,
  };
}

function mintId(prefix: string, used: Set<string>, now: Date): string {
  let candidate = `${prefix}-${now.getTime()}`;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${prefix}-${now.getTime()}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = `${name}（导入）`;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${name}（导入 ${counter}）`;
    counter += 1;
  }
  return candidate;
}
