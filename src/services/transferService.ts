import type { EnergyDevice, EnergyDocument, EnergyScenario } from '../types';

/** 导出信封的格式标识与版本，导入时据此识别来源、判断兼容性 */
export const TRANSFER_FORMAT = 'energy-lens-transfer';
export const TRANSFER_VERSION = 1;

export interface TransferEnvelope {
  format: typeof TRANSFER_FORMAT;
  version: number;
  exportedAt: string;
  scenarios: unknown[];
}

export type ParseTransferResult =
  | { ok: true; envelope: TransferEnvelope }
  | { ok: false; message: string };

export type ScenarioImportStatus = 'ready' | 'adjusted' | 'skipped';

export interface ScenarioImportEntry {
  index: number;
  /** 源数据中的方案名（可能缺失），用于报告展示 */
  sourceName: string;
  status: ScenarioImportStatus;
  /** status 为 skipped 时为 null */
  scenario: EnergyScenario | null;
  /** 对该方案做过的每一处修复或跳过原因，逐条明示 */
  notes: string[];
}

export interface ImportPlan {
  entries: ScenarioImportEntry[];
  importableCount: number;
  skippedCount: number;
}

// ---------- 导出 ----------

export function serializeTransfer(document: EnergyDocument, exportedAt = new Date()): string {
  const envelope: TransferEnvelope = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: exportedAt.toISOString(),
    scenarios: document.scenarios,
  };
  return JSON.stringify(envelope, null, 2);
}

export function transferFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `energy-lens-backup-${stamp}.json`;
}

// ---------- 解析 ----------

export function parseTransferText(rawText: string): ParseTransferResult {
  const text = rawText.trim();
  if (!text) return { ok: false, message: '内容为空，请粘贴导出的文本或选择备份文件' };
  const parsed = tryParseJson(text) ?? tryParseJson(extractJsonSlice(text));
  if (parsed === undefined) return { ok: false, message: '无法识别的内容：不是有效的 JSON 文本' };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, message: '内容不是方案导出数据' };
  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== TRANSFER_FORMAT) {
    const looksLikeStorage = Array.isArray(envelope.scenarios) && typeof envelope.activeScenarioId === 'string';
    return {
      ok: false,
      message: looksLikeStorage
        ? '这看起来是应用的本地存档而不是导出的备份，请使用「导出」功能生成的内容'
        : '内容不是 EnergyLens 导出的方案数据（缺少格式标识）',
    };
  }
  if (typeof envelope.version !== 'number') return { ok: false, message: '导出数据缺少版本号，无法判断兼容性' };
  if (envelope.version > TRANSFER_VERSION) return { ok: false, message: `数据来自更新的版本（v${envelope.version}），当前支持到 v${TRANSFER_VERSION}，请升级应用后再导入` };
  if (envelope.version < 1) return { ok: false, message: `无法识别的数据版本（v${envelope.version}）` };
  if (!Array.isArray(envelope.scenarios) || envelope.scenarios.length === 0) return { ok: false, message: '导出数据中没有可导入的方案' };
  return { ok: true, envelope: envelope as unknown as TransferEnvelope };
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 容忍粘贴时混入的前后杂质，截取最外层 JSON 对象片段 */
function extractJsonSlice(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '';
}

// ---------- 导入规划 ----------

interface ImportContext {
  takenScenarioIds: Set<string>;
  takenNames: Set<string>;
  idCounter: number;
  now: () => number;
}

/**
 * 逐个方案检查导出数据，生成导入计划。
 * 每个方案独立处理：计费参数缺失或非法的方案被明确跳过并说明原因，
 * 不影响其它方案；与现有方案重名或编号冲突时自动改名、重新分配编号，
 * 绝不覆盖已有数据。
 */
export function planImport(envelope: TransferEnvelope, existing: EnergyScenario[], now: () => number = Date.now): ImportPlan {
  const context: ImportContext = {
    takenScenarioIds: new Set(existing.map((scenario) => scenario.id)),
    takenNames: new Set(existing.map((scenario) => scenario.name)),
    idCounter: 1,
    now,
  };
  const entries = envelope.scenarios.map((raw, index) => sanitizeScenario(raw, index, context));
  return {
    entries,
    importableCount: entries.filter((entry) => entry.scenario !== null).length,
    skippedCount: entries.filter((entry) => entry.scenario === null).length,
  };
}

function sanitizeScenario(raw: unknown, index: number, context: ImportContext): ScenarioImportEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return skippedEntry(index, `第 ${index + 1} 个方案`, ['方案数据损坏，已跳过']);
  }
  const source = raw as Record<string, unknown>;
  const sourceName = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `第 ${index + 1} 个方案`;
  const notes: string[] = [];

  // 计费参数直接影响计算结论：缺失或非法时整条跳过，绝不套用默认值
  if (!isFiniteNumber(source.pricePerKwh) || source.pricePerKwh < 0) {
    return skippedEntry(index, sourceName, [`「${sourceName}」的电价缺失或无效，已跳过（不会用默认值代替）`]);
  }
  if (!isFiniteNumber(source.daysPerMonth) || source.daysPerMonth < 1 || source.daysPerMonth > 31) {
    return skippedEntry(index, sourceName, [`「${sourceName}」的计费天数缺失或超出 1–31 天，已跳过`]);
  }
  if (!Array.isArray(source.devices)) {
    return skippedEntry(index, sourceName, [`「${sourceName}」缺少设备清单，已跳过`]);
  }

  const devices: EnergyDevice[] = [];
  const takenDeviceIds = new Set<string>();
  source.devices.forEach((rawDevice: unknown, deviceIndex: number) => {
    const device = sanitizeDevice(rawDevice, deviceIndex, sourceName, takenDeviceIds, context, notes);
    if (device) devices.push(device);
  });
  if (devices.length === 0) {
    return skippedEntry(index, sourceName, [...notes, `「${sourceName}」没有可用的设备数据，已跳过`]);
  }

  let name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name) {
    name = '未命名方案';
    notes.push('原方案缺少名称，已命名为「未命名方案」');
  }
  const uniqueName = ensureUniqueName(name, context);
  if (uniqueName !== name) notes.push(`与已有方案重名，已改名为「${uniqueName}」，已有方案不受影响`);

  let id = typeof source.id === 'string' && source.id ? source.id : '';
  if (!id) {
    id = freshScenarioId(context);
    notes.push('原方案缺少编号，已重新分配');
  } else if (context.takenScenarioIds.has(id)) {
    id = freshScenarioId(context);
    notes.push('方案编号与已有方案冲突，已重新分配，已有方案保持不变');
  } else {
    context.takenScenarioIds.add(id);
  }

  let createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : '';
  if (!createdAt) {
    createdAt = new Date(context.now()).toISOString();
    notes.push('缺少创建时间，已补全为导入时间');
  }

  const scenario: EnergyScenario = {
    id,
    name: uniqueName,
    pricePerKwh: source.pricePerKwh,
    daysPerMonth: source.daysPerMonth,
    devices,
    createdAt,
  };
  return { index, sourceName, status: notes.length > 0 ? 'adjusted' : 'ready', scenario, notes };
}

function sanitizeDevice(
  raw: unknown,
  index: number,
  scenarioName: string,
  takenDeviceIds: Set<string>,
  context: ImportContext,
  notes: string[],
): EnergyDevice | null {
  const label = `「${scenarioName}」第 ${index + 1} 台设备`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    notes.push(`${label}数据损坏，已移除`);
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (!isFiniteNumber(source.watts) || source.watts < 0) {
    notes.push(`${label}功率缺失或无效，已移除`);
    return null;
  }
  if (!isFiniteNumber(source.dailyHours) || source.dailyHours < 0 || source.dailyHours > 24) {
    notes.push(`${label}每日使用时长缺失或超出 0–24 小时，已移除`);
    return null;
  }
  let name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name) {
    name = '未命名设备';
    notes.push(`${label}缺少名称，已命名为「未命名设备」`);
  }
  let id = typeof source.id === 'string' && source.id ? source.id : '';
  if (id && takenDeviceIds.has(id)) {
    notes.push(`${label}编号与同方案其它设备重复，已重新分配`);
    id = '';
  }
  if (!id) id = freshDeviceId(context, takenDeviceIds);
  takenDeviceIds.add(id);
  return { id, name, watts: source.watts, dailyHours: source.dailyHours };
}

function skippedEntry(index: number, sourceName: string, notes: string[]): ScenarioImportEntry {
  return { index, sourceName, status: 'skipped', scenario: null, notes };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function ensureUniqueName(name: string, context: ImportContext): string {
  if (!context.takenNames.has(name)) {
    context.takenNames.add(name);
    return name;
  }
  let candidate = `${name} · 导入`;
  let suffix = 2;
  while (context.takenNames.has(candidate)) {
    candidate = `${name} · 导入 ${suffix}`;
    suffix += 1;
  }
  context.takenNames.add(candidate);
  return candidate;
}

function freshScenarioId(context: ImportContext): string {
  let id = '';
  do {
    id = `scenario-import-${context.now()}-${context.idCounter}`;
    context.idCounter += 1;
  } while (context.takenScenarioIds.has(id));
  context.takenScenarioIds.add(id);
  return id;
}

function freshDeviceId(context: ImportContext, takenDeviceIds: Set<string>): string {
  let id = '';
  do {
    id = `device-import-${context.now()}-${context.idCounter}`;
    context.idCounter += 1;
  } while (takenDeviceIds.has(id));
  return id;
}
