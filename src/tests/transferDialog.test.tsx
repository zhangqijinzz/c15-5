// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TransferDialog } from '../components/TransferDialog';
import { exampleScenario } from '../domain';
import { serializeTransfer } from '../services/transferService';
import type { EnergyDocument, EnergyScenario } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const secondScenario: EnergyScenario = {
  id: 'scenario-office',
  name: '工作室方案',
  pricePerKwh: 1,
  daysPerMonth: 30,
  createdAt: '2026-01-01T00:00:00.000Z',
  devices: [{ id: 'device-lamp-b', name: '台灯', watts: 10, dailyHours: 1 }],
};

function makeDocument(): EnergyDocument {
  return {
    version: 1,
    scenarios: [structuredClone(exampleScenario), structuredClone(secondScenario)],
    activeScenarioId: exampleScenario.id,
  };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('TransferDialog', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
  });

  async function renderDialog(
    onImport: Mock<(scenarios: EnergyScenario[]) => boolean> = vi.fn(() => true),
    onClose: Mock = vi.fn(),
  ) {
    const doc = makeDocument();
    await act(async () => {
      root = createRoot(container);
      root.render(<TransferDialog doc={doc} onImport={onImport} onClose={onClose} />);
    });
    return { doc, onImport, onClose };
  }

  it('shows the whole document as transferable text on the export tab', async () => {
    await renderDialog();
    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toContain('"format": "energy-lens-transfer"');
    expect(JSON.parse(textarea?.value ?? '{}').scenarios).toHaveLength(2);
  });

  it('analyzes pasted content, reports each scenario and imports only the checked ones', async () => {
    const { onImport, onClose } = await renderDialog();
    await act(async () => { findButton(container, '导入方案').click(); });

    // 粘贴的备份与现有方案完全重名、编号冲突
    const incoming = serializeTransfer(makeDocument());
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    await act(async () => { setTextareaValue(textarea, incoming); });
    await act(async () => { findButton(container, '检查内容').click(); });

    expect(container.textContent).toContain('识别到 2 个方案');
    expect(container.textContent).toContain('夏日居家方案 · 导入');
    expect(container.textContent).toContain('工作室方案 · 导入');
    expect(container.textContent).toContain('已有方案保持不变');

    // 取消勾选第一个，只导入第二个
    const firstCheckbox = container.querySelector<HTMLInputElement>('.transfer-entry input[type="checkbox"]');
    if (!firstCheckbox) throw new Error('checkbox missing');
    await act(async () => { firstCheckbox.click(); });
    await act(async () => { findButton(container, '导入 1 个方案').click(); });

    expect(onImport).toHaveBeenCalledTimes(1);
    const imported = onImport.mock.calls[0][0] as EnergyScenario[];
    expect(imported).toHaveLength(1);
    expect(imported[0].name).toBe('工作室方案 · 导入');
    expect(imported[0].id).not.toBe(secondScenario.id);
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects content that is not an export and imports nothing', async () => {
    const { onImport } = await renderDialog();
    await act(async () => { findButton(container, '导入方案').click(); });
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    await act(async () => { setTextareaValue(textarea, '{"hello": 1}'); });
    await act(async () => { findButton(container, '检查内容').click(); });

    expect(container.textContent).toContain('不是 EnergyLens 导出的方案数据');
    expect(onImport).not.toHaveBeenCalled();
  });

  it('stays open when the import cannot be persisted', async () => {
    const onImport: Mock<(scenarios: EnergyScenario[]) => boolean> = vi.fn(() => false);
    const onClose: Mock = vi.fn();
    await renderDialog(onImport, onClose);
    await act(async () => { findButton(container, '导入方案').click(); });
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    await act(async () => { setTextareaValue(textarea, serializeTransfer(makeDocument())); });
    await act(async () => { findButton(container, '检查内容').click(); });
    await act(async () => { findButton(container, '导入 2 个方案').click(); });

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
