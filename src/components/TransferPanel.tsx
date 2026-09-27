import { useRef, useState, type ChangeEvent } from 'react';
import type { EnergyLensState, EnergyLensViewModel } from '../viewModel';

interface TransferPanelProps {
  vm: EnergyLensViewModel;
  state: EnergyLensState;
}

export function TransferPanel({ vm, state }: TransferPanelProps) {
  const [exportText, setExportText] = useState('');
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState(false);
  const exportRef = useRef<HTMLTextAreaElement>(null);

  const generateExport = () => {
    setExportText(vm.exportText() ?? '');
    setCopied(false);
  };

  const copyExport = async () => {
    if (!exportText) return;
    try {
      await navigator.clipboard.writeText(exportText);
    } catch {
      exportRef.current?.select();
    }
    setCopied(true);
  };

  const downloadExport = () => {
    if (!exportText) return;
    const url = URL.createObjectURL(new Blob([exportText], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `energy-lens-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void file.text().then(setImportText);
  };

  return (
    <section className="transfer-section">
      <div className="section-title">
        <div><span className="step">05</span><h2>备份与迁移</h2><p>导出为文件或一段文本，换设备也能完整还原</p></div>
      </div>
      <div className="transfer-grid">
        <div className="transfer-card">
          <h3>导出方案</h3>
          <p>包含全部方案的设备明细与计费参数，可下载为文件，也可复制为文本粘贴到别处。</p>
          <div className="transfer-actions">
            <button className="secondary-button" onClick={generateExport}>生成导出内容</button>
            <button className="secondary-button" onClick={copyExport} disabled={!exportText}>{copied ? '已复制 ✓' : '复制文本'}</button>
            <button className="primary-button" onClick={downloadExport} disabled={!exportText}>下载文件</button>
          </div>
          {exportText && <textarea ref={exportRef} readOnly value={exportText} aria-label="导出内容" onFocus={(event) => event.target.select()} />}
        </div>
        <div className="transfer-card">
          <h3>导入方案</h3>
          <p>粘贴备份文本或选择备份文件。重名或编号冲突会自动区分，不会覆盖已有方案。</p>
          <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴导出的 JSON 文本，或选择备份文件…" aria-label="导入内容" />
          <div className="transfer-actions">
            <label className="secondary-button file-button">选择文件<input type="file" accept=".json,application/json" className="sr-only" onChange={pickFile} /></label>
            <button className="primary-button" onClick={() => vm.importFromText(importText)} disabled={!importText.trim()}>开始导入</button>
          </div>
          {state.transferEntries && (
            <ul className="transfer-report">
              {state.transferEntries.map((entry, index) => (
                <li key={index} className={entry.outcome}>
                  <strong>{entry.outcome === 'imported' ? '✓' : '×'} {entry.sourceName}</strong>
                  {entry.notes.length > 0 && <span>{entry.notes.join('；')}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
