// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard, downloadTextFile } from '../services/fileTransfer';

describe('fileTransfer helpers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('downloads text through a temporary anchor with a JSON blob URL', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    downloadTextFile('backup.json', '{"ok":true}');

    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('falls back to execCommand when the async clipboard API is unavailable', async () => {
    expect(navigator.clipboard).toBeUndefined();
    const execCommand = vi.fn(() => true);
    Object.assign(document, { execCommand });

    const succeeded = await copyTextToClipboard('hello-backup');
    expect(succeeded).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports failure honestly when both clipboard paths fail', async () => {
    Object.assign(document, { execCommand: vi.fn(() => { throw new Error('blocked'); }) });
    expect(await copyTextToClipboard('x')).toBe(false);
  });
});
