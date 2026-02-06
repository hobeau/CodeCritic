const vscode = require('vscode');

/** @type {vscode.WebviewView | undefined} */
let aiSugarView;
let aiSugarState = { thinking: false, outcome: null, toolMessage: '', attractorStrength: 0 };

async function buildAiSugarHtml(webview, extensionUri) {
  const fileUri = vscode.Uri.joinPath(extensionUri, 'views', 'AISphere.html');
  const bytes = await vscode.workspace.fs.readFile(fileUri);
  let html = Buffer.from(bytes).toString('utf8');
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'`;
  html = html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
  return html;
}

function postAiSugarState() {
  if (!aiSugarView) return;
  try {
    aiSugarView.webview.postMessage({ type: 'sugarState', ...aiSugarState });
  } catch {
    // Ignore webview dispatch errors so chat flow doesn't break.
  }
}

function updateAiSugarState(next) {
  aiSugarState = { ...aiSugarState, ...next };
  postAiSugarState();
}

function registerAiSugarFeature({ context }) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'codeCritic.aiSugarView',
      {
        async resolveWebviewView(view) {
          aiSugarView = view;

          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'views')]
          };

          view.webview.html = await buildAiSugarHtml(view.webview, context.extensionUri);

          view.onDidDispose(() => {
            aiSugarView = undefined;
          });

          postAiSugarState();
        }
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.showAiSugar', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.codeCritic');
      await vscode.commands.executeCommand('codeCritic.aiSugarView.focus');
      postAiSugarState();
    })
  );
}

module.exports = {
  registerAiSugarFeature,
  updateAiSugarState
};
