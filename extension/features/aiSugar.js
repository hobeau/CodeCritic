const vscode = require('vscode');

let aiSugarPanel;
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
  if (!aiSugarPanel) return;
  try {
    aiSugarPanel.webview.postMessage({ type: 'sugarState', ...aiSugarState });
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
    vscode.commands.registerCommand('codeCritic.showAiSugar', async () => {
      if (aiSugarPanel) {
        aiSugarPanel.reveal(vscode.ViewColumn.Beside);
        postAiSugarState();
        return;
      }

      aiSugarPanel = vscode.window.createWebviewPanel(
        'codeCritic.aiSugar',
        'AI Sugar',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'views')]
        }
      );

      aiSugarPanel.onDidDispose(() => {
        aiSugarPanel = undefined;
      });

      aiSugarPanel.webview.html = await buildAiSugarHtml(aiSugarPanel.webview, context.extensionUri);
      postAiSugarState();
    })
  );
}

module.exports = {
  registerAiSugarFeature,
  updateAiSugarState
};
