const vscode = require('vscode');
const { isTokenEstimateEnabled } = require('./config');

let outputChannel;
let tokenStatusBarItem;
let outputBuffer = [];
let outputBufferSize = 0;
const OUTPUT_BUFFER_LIMIT = 200000;

function recordOutputChunk(text) {
  const chunk = String(text || '');
  if (!chunk) return;
  outputBuffer.push(chunk);
  outputBufferSize += chunk.length;
  while (outputBufferSize > OUTPUT_BUFFER_LIMIT && outputBuffer.length) {
    const removed = outputBuffer.shift();
    outputBufferSize -= removed.length;
  }
}

function clearOutputBuffer() {
  outputBuffer = [];
  outputBufferSize = 0;
}

function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Code Critic');
  }
  if (outputChannel && !outputChannel.__codeCriticWrapped) {
    const originalAppend = outputChannel.append.bind(outputChannel);
    const originalAppendLine = outputChannel.appendLine.bind(outputChannel);
    const originalClear = typeof outputChannel.clear === 'function' ? outputChannel.clear.bind(outputChannel) : null;

    outputChannel.append = (value) => {
      recordOutputChunk(String(value || ''));
      return originalAppend(value);
    };
    outputChannel.appendLine = (value) => {
      recordOutputChunk(String(value || '') + '\n');
      return originalAppendLine(value);
    };
    if (originalClear) {
      outputChannel.clear = () => {
        clearOutputBuffer();
        return originalClear();
      };
    }
    outputChannel.__codeCriticWrapped = true;
  }
  return outputChannel;
}

function disposeOutputChannel() {
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = undefined;
  }
  clearOutputBuffer();
}

function getTokenStatusBarItem() {
  if (!tokenStatusBarItem) {
    tokenStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    tokenStatusBarItem.text = 'CodeCritic: tokens n/a';
    tokenStatusBarItem.tooltip = 'Approximate token estimate for the last Code Critic review payload.';
    tokenStatusBarItem.show();
  }
  return tokenStatusBarItem;
}

function disposeTokenStatusBarItem() {
  if (tokenStatusBarItem) {
    tokenStatusBarItem.dispose();
    tokenStatusBarItem = undefined;
  }
}

function updateTokenEstimate(totalChars) {
  if (!isTokenEstimateEnabled()) return;
  const approxTokens = Math.max(1, Math.ceil(totalChars / 4));
  const item = getTokenStatusBarItem();
  item.text = `CodeCritic: ~${approxTokens.toLocaleString()} tokens`;
  item.tooltip = `Approximate tokens: ${approxTokens.toLocaleString()} (chars: ${totalChars.toLocaleString()}).`;
  item.show();
}

function readOutputBuffer({ maxChars, tail } = {}) {
  const limit = Math.max(200, Number(maxChars || 12000));
  const useTail = tail !== false;
  const full = outputBuffer.join('');
  const total = full.length;
  if (!full) return { text: '', total: 0, truncated: false };
  if (total <= limit) return { text: full, total, truncated: false };
  const text = useTail ? full.slice(-limit) : full.slice(0, limit);
  return { text, total, truncated: true, tail: useTail };
}

module.exports = {
  getOutputChannel,
  disposeOutputChannel,
  getTokenStatusBarItem,
  disposeTokenStatusBarItem,
  updateTokenEstimate,
  readOutputBuffer
};
