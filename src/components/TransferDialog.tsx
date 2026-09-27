import { useMemo, useRef, useState } from 'react';
import { copyTextToClipboard, downloadTextFile } from '../services/fileTransfer';
import { parseTransferText, planImport, serializeTransfer, transferFileName, type ImportPlan } from '../services/transferService';
import type { EnergyDocument, EnergyScenario } from '../types';

interface TransferDialogProps {
  doc: EnergyDocument;
  /** 返回是否成功写入；失败时对话框保持打开，用户可重试 */
  onImport: (scenarios: EnergyScenario[]) => boolean;
  onClose: () => void;
}

type CopyState = 'idle' | 'done' | 'failed';

export function TransferDialog({ doc, onImport, onClose }: TransferDialogProps) {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const exportText = useMemo(() => serializeTransfer(doc), [doc]);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [importText, setImportText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const analyze = (text: string) => {
    const result = parseTransferText(text);
    if (!result.ok) {
      setParseError(result.message);
      setPlan(null);
      return;
    }
    setParseError(null);
    setPlan(planImport(result.envelope, doc.scenarios));
    setExcluded(new Set());
  };

  const handleCopy = async () => {
    const succeeded = await copyTextToClipboard(exportText);
    setCopyState(succeeded ? 'done' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 2000);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setImportText(text);
      analyze(text);
    } catch {
      setParseError('文件读取失败，请重试或直接粘贴内容');
      setPlan(null);
    }
  };

  const toggleExcluded = (index: number) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectedScenarios = plan
    ? plan.entries.flatMap((entry) => (entry.scenario && !excluded.has(entry.index) ? [entry.scenario] : []))
    : [];

  const confirmImport = () => {
    if (selectedScenarios.length === 0) return;
    if (onImport(selectedScenarios)) onClose();
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="导出与导入" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div className="dialog-tabs">
            <button className={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')}>导出备份</button>
            <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>导入方案</button>
          </div>
          <button className="icon-button dialog-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        {tab === 'export' ? (
          <div className="dialog-body">
            <p className="dialog-hint">把全部 {doc.scenarios.length} 个方案存成文件，或复制为一段文本带走。重新导入时设备明细与计费参数会完整还原，计算结论与现在一致。</p>
            <textarea className="transfer-text" readOnly rows={10} value={exportText} onFocus={(event) => event.target.select()} aria-label="导出内容" />
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => void handleCopy()}>
                {copyState === 'done' ? '✓ 已复制' : copyState === 'failed' ? '复制失败，请手动全选' : '复制文本'}
              </button>
              <button className="primary-button" onClick={() => downloadTextFile(transferFileName(), exportText)}>下载备份文件</button>
            </div>
          </div>
        ) : (
          <div className="dialog-body">
            <p className="dialog-hint">粘贴导出的文本，或选择之前下载的备份文件。导入前会逐项检查并列出处理结果，已有方案不会被覆盖。</p>
            <textarea
              className="transfer-text"
              rows={7}
              placeholder={'粘贴以 {"format": "energy-lens-transfer", ...} 开头的导出内容'}
              value={importText}
              onChange={(event) => {
                setImportText(event.target.value);
                setPlan(null);
                setParseError(null);
              }}
              aria-label="导入内容"
            />
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => fileInputRef.current?.click()}>选择文件…</button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(event) => {
                  void handleFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <button className="primary-button" onClick={() => analyze(importText)} disabled={!importText.trim()}>检查内容</button>
            </div>

            {parseError && <div className="notice error transfer-error" role="alert"><span>!</span>{parseError}</div>}

            {plan && (
              <div className="transfer-report">
                <p className="report-summary">
                  识别到 {plan.entries.length} 个方案：{plan.importableCount} 个可导入{plan.skippedCount > 0 ? `，${plan.skippedCount} 个已跳过` : ''}。
                </p>
                <ul className="transfer-entries">
                  {plan.entries.map((entry) => (
                    <li key={entry.index} className={`transfer-entry ${entry.status}`}>
                      <label className="entry-line">
                        <input
                          type="checkbox"
                          checked={entry.scenario !== null && !excluded.has(entry.index)}
                          disabled={entry.scenario === null}
                          onChange={() => toggleExcluded(entry.index)}
                        />
                        <span className="entry-name">{entry.sourceName}</span>
                        <span className={`entry-pill ${entry.status}`}>
                          {entry.status === 'ready' ? '可导入' : entry.status === 'adjusted' ? '调整后导入' : '已跳过'}
                        </span>
                      </label>
                      {entry.notes.length > 0 && (
                        <ul className="entry-notes">{entry.notes.map((note, noteIndex) => <li key={noteIndex}>{note}</li>)}</ul>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="dialog-actions">
                  <button className="secondary-button" onClick={onClose}>取消</button>
                  <button className="primary-button" onClick={confirmImport} disabled={selectedScenarios.length === 0}>
                    导入 {selectedScenarios.length} 个方案
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
