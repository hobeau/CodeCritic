const vscode = require('vscode');

function isDebugEnabled() {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  return Boolean(cfg.get('debugMode', false));
}

function isTokenEstimateEnabled() {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  return Boolean(cfg.get('showTokenEstimate', true));
}

function getMethodReviewConfig() {
  const cfg = vscode.workspace.getConfiguration('codeCritic.methodReview');
  return {
    maxDependencyDepth: Number(cfg.get('maxDependencyDepth', 1)),
    maxDependencies: Number(cfg.get('maxDependencies', 8))
  };
}

function getChatHistoryCharLimit() {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const raw = Number(cfg.get('chatHistoryChars', 32000));
  if (!Number.isFinite(raw)) return 32000;
  return Math.max(0, Math.floor(raw));
}

function getAgentMaxSteps() {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const raw = Number(cfg.get('agentMaxSteps', 6));
  if (!Number.isFinite(raw)) return 6;
  return Math.max(1, Math.min(50, Math.floor(raw)));
}

function getAdoConfig() {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  return {
    orgUrl: String(cfg.get('ado.organizationUrl', '') || '').trim(),
    project: String(cfg.get('ado.project', '') || '').trim(),
    repo: String(cfg.get('ado.repo', '') || '').trim(),
    prId: String(cfg.get('ado.prId', '') || '').trim(),
    autoDetectPrFromBranch: Boolean(cfg.get('ado.autoDetectPrFromBranch', true))
  };
}

module.exports = {
  isDebugEnabled,
  isTokenEstimateEnabled,
  getMethodReviewConfig,
  getChatHistoryCharLimit,
  getAgentMaxSteps,
  getAdoConfig
};
