/* eslint-disable @typescript-eslint/no-var-requires */
const vscode = require('vscode');
const { CONTROLLER_ID } = require('./helpers/constants');
const { isDebugEnabled, isTokenEstimateEnabled } = require('./helpers/config');
const {
  getOutputChannel,
  disposeOutputChannel,
  getTokenStatusBarItem,
  disposeTokenStatusBarItem
} = require('./helpers/output');
const { registerReviewFeature, clearAllThreads } = require('./features/review');
const { registerChatFeature } = require('./features/chat');
const { registerAdoFeature } = require('./features/ado');

/** @type {vscode.CommentController | undefined} */
let controller;

const threadState = {
  threadSet: new Set(),
  adoThreadSet: new Set(),
  adoThreadMeta: new Map(),
  threadContext: new Map(),
  proposedChanges: new Map()
};

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Code Critic');
  controller.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      const lastLine = Math.max(0, doc.lineCount - 1);
      return { ranges: [new vscode.Range(0, 0, lastLine, 0)], enableFileComments: true };
    }
  };

  context.subscriptions.push(controller);

  if (isDebugEnabled()) {
    getOutputChannel();
  }
  if (isTokenEstimateEnabled()) {
    getTokenStatusBarItem();
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeCritic.debugMode')) {
        if (isDebugEnabled()) {
          getOutputChannel();
        } else {
          disposeOutputChannel();
        }
      }
      if (e.affectsConfiguration('codeCritic.showTokenEstimate')) {
        if (isTokenEstimateEnabled()) {
          getTokenStatusBarItem();
        } else {
          disposeTokenStatusBarItem();
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
      provideCodeActions(document, range) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.toString() !== document.uri.toString()) return;
        if (range.isEmpty || editor.selection.isEmpty) return;
        const reviewAction = new vscode.CodeAction(
          'Code Critic Review: Review',
          vscode.CodeActionKind.Refactor.append('codeCriticReview')
        );
        reviewAction.command = { command: 'codeCritic.reviewSelection' };
        const chatAction = new vscode.CodeAction(
          'Code Critic Chat: Ask About Selection',
          vscode.CodeActionKind.Refactor.append('codeCriticChat')
        );
        chatAction.command = { command: 'codeCritic.chatWithSelection' };
        return [reviewAction, chatAction];
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.clear', async () => {
      clearAllThreads(threadState);
      vscode.window.showInformationMessage('CodeCritic: Cleared review comments.');
    })
  );

  registerReviewFeature({ context, controller, threadState });
  registerChatFeature({ context, threadState });
  registerAdoFeature({ context, controller, threadState });
}

function deactivate() {
  if (controller) {
    controller.dispose();
    controller = undefined;
  }
  disposeOutputChannel();
  disposeTokenStatusBarItem();
}

module.exports = {
  activate,
  deactivate
};
