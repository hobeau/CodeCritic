const vscode = require('vscode');

const { createToolRunner } = require('../agentTools');

function makeRunner(fileText, options = {}) {
  const workspaceRoot = '/workspace';
  const activePath = options.activePath || '';

  vscode.workspace.fs.readFile = jest.fn(async () => Buffer.from(String(fileText), 'utf8'));
  if (activePath) {
    vscode.window.activeTextEditor = { document: { uri: { fsPath: activePath } } };
  } else {
    vscode.window.activeTextEditor = undefined;
  }

  return createToolRunner({
    vscode,
    getWorkspaceRoot: () => workspaceRoot,
    resolveWorkspacePathForTool: (p) => {
      const raw = String(p || '').trim();
      if (!raw) return '';
      if (raw.startsWith(workspaceRoot)) return raw;
      return `${workspaceRoot}/${raw.replace(/^\/+/, '')}`;
    },
    toWorkspaceRelativePath: (p) => {
      const raw = String(p || '');
      if (raw === workspaceRoot) return '';
      if (raw.startsWith(workspaceRoot + '/')) return raw.slice(workspaceRoot.length + 1);
      return raw;
    },
    updateSelectionContextsForEdit: () => {},
    requestApproval: async () => true,
    getThreadState: () => ({})
  });
}

describe('read_file bounds handling', () => {
  test('clamps endLine beyond file and returns available lines', async () => {
    const runner = makeRunner('a\nb\nc');
    const result = await runner.toolReadFile({ path: 'x.txt', startLine: 1, endLine: 10 });
    expect(result).toContain('Note:');
    expect(result).toContain('returned 1-3');
    expect(result).toContain('1 | a');
    expect(result).toContain('2 | b');
    expect(result).toContain('3 | c');
  });

  test('reports valid range when startLine exceeds file length', async () => {
    const runner = makeRunner('a\nb\nc');
    const result = await runner.toolReadFile({ path: 'x.txt', startLine: 9, endLine: 12 });
    expect(result).toContain('Read failed:');
    expect(result).toContain('file has 3 lines');
    expect(result).toContain('valid range: 1-3');
  });

  test('clamps startLine below 1', async () => {
    const runner = makeRunner('a\nb\nc');
    const result = await runner.toolReadFile({ path: 'x.txt', startLine: 0, endLine: 2 });
    expect(result).toContain('Note:');
    expect(result).toContain('startLine clamped');
    expect(result).toContain('1 | a');
    expect(result).toContain('2 | b');
  });

  test('does not add a note when range is in-bounds', async () => {
    const runner = makeRunner('a\nb\nc');
    const result = await runner.toolReadFile({ path: 'x.txt', startLine: 2, endLine: 3 });
    expect(result.startsWith('Note:')).toBe(false);
    expect(result).toContain('2 | b');
    expect(result).toContain('3 | c');
  });

  test('returns clear error when path omitted (no fallback)', async () => {
    const runner = makeRunner('a\nb\nc');
    await runner.toolReadFile({ path: 'x.txt', startLine: 1, endLine: 1 });
    const result = await runner.toolReadFile({ startLine: 2, endLine: 3 });
    expect(result).toContain('path is required');
  });

  test('returns clear error when path omitted even with active editor', async () => {
    const runner = makeRunner('a\nb\nc', { activePath: '/workspace/active.txt' });
    const result = await runner.toolReadFile({ startLine: 1, endLine: 2 });
    expect(result).toContain('path is required');
  });

  test('fails when path omitted and no fallback exists', async () => {
    const runner = makeRunner('a\nb\nc');
    const result = await runner.toolReadFile({ startLine: 1, endLine: 2 });
    expect(result).toContain('Read failed: path is required');
  });

  test('strips line range tokens from path', async () => {
    const runner = makeRunner('a\nb\nc');
    const result = await runner.toolReadFile({ path: 'x.txt lines 1-2', startLine: 1, endLine: 2 });
    expect(result).toContain('1 | a');
    expect(result).toContain('2 | b');
  });
});
