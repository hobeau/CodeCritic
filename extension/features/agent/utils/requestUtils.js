/**
 * requestUtils - Helpers for extracting user intent and file hints from context/messages
 */

function getCandidateMessagesForUserRequest(context) {
  const chatState = (context && typeof context.getChatState === 'function')
    ? (context.getChatState() || {})
    : {};

  const candidates = [
    Array.isArray(chatState.baseMessages) ? chatState.baseMessages : null,
    Array.isArray(chatState.messages) ? chatState.messages : null,
    Array.isArray(context && context.uiMessages) ? context.uiMessages : null,
    Array.isArray(context && context.modelMessages) ? context.modelMessages : null
  ].filter((arr) => Array.isArray(arr) && arr.length);

  return candidates[0] || [];
}

function extractLastUserRequest(context) {
  const messages = getCandidateMessagesForUserRequest(context);
  const userMessages = messages.filter((m) => m && m.role === 'user');
  if (!userMessages.length) return '';
  const last = userMessages[userMessages.length - 1];
  return typeof last.content === 'string' ? last.content : String(last.content || '');
}

function extractRequestedFilePathsFromText(text) {
  const src = String(text || '');
  if (!src) return [];
  const matches = src.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) || [];
  const unique = new Set();
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;:]+$/g, '');
    if (cleaned) unique.add(cleaned);
  }
  return Array.from(unique);
}

function extractRequestedFilePathsFromMessages(context) {
  const messages = getCandidateMessagesForUserRequest(context);
  const paths = new Set();

  for (const msg of messages) {
    if (!msg || typeof msg.content !== 'string') continue;
    const content = msg.content;

    // Diagnostics-style entries: path:line:col
    const diagMatches = content.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):\d+:\d+/g) || [];
    for (const match of diagMatches) {
      const filePath = match.split(':')[0];
      if (filePath) paths.add(filePath);
    }

    // Plain file tokens
    const fileMatches = content.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) || [];
    for (const match of fileMatches) {
      const cleaned = match.replace(/[),.;:]+$/g, '');
      if (cleaned) paths.add(cleaned);
    }
  }

  return Array.from(paths);
}

module.exports = {
  extractLastUserRequest,
  extractRequestedFilePathsFromText,
  extractRequestedFilePathsFromMessages
};

