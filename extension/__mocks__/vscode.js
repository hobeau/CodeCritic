const workspaceRoot = process.cwd();

function getConfiguration() {
  return {
    get: (_key, defaultValue) => defaultValue
  };
}

module.exports = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration,
    fs: {
      stat: async () => ({}),
      readFile: async () => Buffer.from(''),
      writeFile: async () => {},
      createDirectory: async () => {},
      delete: async () => {},
      rename: async () => {}
    }
  },
  Uri: {
    file: (fsPath) => ({ fsPath })
  },
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {}
    })
  }
};

