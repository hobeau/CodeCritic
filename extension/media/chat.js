window.onerror = function(message) {
  const statusEl = document.getElementById('status');
  if (statusEl && message) {
    statusEl.textContent = 'UI error: ' + String(message);
  }
  return false;
};

let vscodeApi = null;
let apiError = null;
const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('input');
const commandMenu = document.getElementById('commandMenu');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const threadSelect = document.getElementById('threadSelect');
const newChatBtn = document.getElementById('newChat');
const modelSelect = document.getElementById('modelSelect');
const modeEl = document.getElementById('mode');
const debugToggleBtn = document.getElementById('debugListen');
const tabButtons = Array.from(document.querySelectorAll('[data-tab]'));
const tabChat = document.getElementById('tabChat');
const tabContext = document.getElementById('tabContext');
const contextChips = document.getElementById('contextChips');
const contextCount = document.getElementById('contextCount');
const contextCountDetail = document.getElementById('contextCountDetail');
const contextList = document.getElementById('contextList');
const todosEl = document.getElementById('todos');
const approvalsEl = document.getElementById('approvals');
const addContextFromSelectionBtn = document.getElementById('addContextFromSelection');
const addContextFromSelectionDetailBtn = document.getElementById('addContextFromSelectionDetail');
const addContextNoteBtn = document.getElementById('addContextNote');
const contextNoteInput = document.getElementById('contextNote');
const clearContextBtn = document.getElementById('clearContext');
const clearContextAllBtn = document.getElementById('clearContextAll');
const statusEl = document.getElementById('status');

let state = {
  mode: 'chat',
  contexts: [],
  todos: [],
  plan: [],
  messages: [],
  busy: false,
  threads: [],
  activeThreadId: null,
  debugListenEnabled: false,
  models: [],
  activeModel: ''
};
let activeTab = 'chat';
let editingContextId = null;
let composing = false;

const COMMANDS = [
  { command: '/debugger', description: 'Use debugger snapshot' },
  { command: '/search', description: 'Search workspace text' },
  { command: '/symbols', description: 'Search workspace symbols' }
];
const COMMAND_SET = new Set(COMMANDS.map((item) => item.command));
let commandState = { open: false, items: [], activeIndex: 0, start: 0, end: 0 };

try {
  vscodeApi = acquireVsCodeApi();
} catch (err) {
  apiError = err || new Error('VS Code API unavailable');
}

if (apiError && statusEl) {
  statusEl.textContent = 'VS Code API unavailable';
}

function postVsCodeMessage(payload) {
  if (!vscodeApi || typeof vscodeApi.postMessage !== 'function') return false;
  try {
    vscodeApi.postMessage(payload);
    return true;
  } catch {
    return false;
  }
}

function logUi(message) {
  postVsCodeMessage({ type: 'log', message: String(message || '') });
}

window.addEventListener('error', (e) => {
  if (statusEl && e && e.message) {
    statusEl.textContent = 'UI error: ' + e.message;
    logUi('UI error: ' + e.message);
  }
});
window.addEventListener('unhandledrejection', (e) => {
  if (statusEl && e && e.reason) {
    statusEl.textContent = 'UI error: ' + String(e.reason);
    logUi('UI error: ' + String(e.reason));
  }
});

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('codecritic-open:')) return raw;
  return '';
}

function getInputValue() {
  if (!inputEl) return '';
  const raw = inputEl.innerText || '';
  return raw.replace(/\u00a0/g, ' ').replace(/\r/g, '');
}

function escapeAndConvert(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function buildHighlightedHtml(text) {
  if (!text) return '';
  const re = /(^|[\s])(\/[a-zA-Z0-9_-]+)\b/g;
  let idx = 0;
  let html = '';
  let match;
  while ((match = re.exec(text)) !== null) {
    const prefix = match[1] || '';
    const token = match[2] || '';
    const start = match.index + prefix.length;
    html += escapeAndConvert(text.slice(idx, start));
    const escapedToken = escapeHtml(token);
    html += COMMAND_SET.has(token)
      ? `<span class="token-command">${escapedToken}</span>`
      : escapedToken;
    idx = start + token.length;
  }
  html += escapeAndConvert(text.slice(idx));
  return html;
}

function getCaretIndex(el) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  const preRange = range.cloneRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

function setCaretIndex(el, index) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  let remaining = Math.max(0, Number(index || 0));

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (remaining <= text.length) {
        range.setStart(node, remaining);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
      remaining -= text.length;
      return false;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR') {
        if (remaining <= 1) {
          range.setStartAfter(node);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          return true;
        }
        remaining -= 1;
        return false;
      }
      for (const child of node.childNodes) {
        if (walk(child)) return true;
      }
    }
    return false;
  }

  if (!walk(el)) {
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function insertPlainTextAtCursor(el, text) {
  if (!el) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    el.innerText = (el.innerText || '') + text;
    return;
  }
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer)) {
    el.innerText = (el.innerText || '') + text;
    return;
  }
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderRichInput() {
  if (!inputEl) return;
  const text = getInputValue();
  const caret = getCaretIndex(inputEl);
  const html = buildHighlightedHtml(text);
  if (inputEl.innerHTML !== html) {
    inputEl.innerHTML = html;
  }
  setCaretIndex(inputEl, caret);
}

function setInputValue(text, caretIndex) {
  if (!inputEl) return;
  const html = buildHighlightedHtml(text || '');
  inputEl.innerHTML = html;
  const idx = Number.isFinite(Number(caretIndex)) ? Number(caretIndex) : String(text || '').length;
  setCaretIndex(inputEl, idx);
}

function getCommandContext() {
  if (!inputEl) return null;
  const text = getInputValue();
  const caret = getCaretIndex(inputEl);
  const before = text.slice(0, caret);
  const match = /(^|[\s])\/([^\s]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] || '';
  const start = before.lastIndexOf('/' + query);
  if (start === -1) return null;
  return { query, start, end: caret };
}

function renderCommandMenu(items, activeIndex) {
  if (!commandMenu) return;
  commandMenu.innerHTML = '';
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const row = document.createElement('div');
    row.className = 'command-item' + (i === activeIndex ? ' is-active' : '');
    row.dataset.command = item.command;
    row.dataset.index = String(i);
    const name = document.createElement('span');
    name.className = 'command-name';
    name.textContent = item.command;
    const desc = document.createElement('span');
    desc.className = 'command-desc';
    desc.textContent = item.description || '';
    row.appendChild(name);
    row.appendChild(desc);
    commandMenu.appendChild(row);
  }
}

function showCommandMenu(items, activeIndex) {
  if (!commandMenu) return;
  renderCommandMenu(items, activeIndex);
  commandMenu.classList.add('is-open');
  commandMenu.setAttribute('aria-hidden', 'false');
}

function hideCommandMenu() {
  if (!commandMenu) return;
  commandMenu.classList.remove('is-open');
  commandMenu.setAttribute('aria-hidden', 'true');
  commandMenu.innerHTML = '';
  commandState = { open: false, items: [], activeIndex: 0, start: 0, end: 0 };
}

function updateCommandMenu() {
  if (!inputEl) return;
  const ctx = getCommandContext();
  if (!ctx) {
    hideCommandMenu();
    return;
  }
  const matches = COMMANDS.filter((item) => item.command.startsWith('/' + ctx.query));
  if (!matches.length) {
    hideCommandMenu();
    return;
  }
  const activeIndex = Math.max(0, Math.min(commandState.activeIndex || 0, matches.length - 1));
  commandState = {
    open: true,
    items: matches,
    activeIndex,
    start: ctx.start,
    end: ctx.end
  };
  showCommandMenu(matches, activeIndex);
}

function applyCommandSelection(index) {
  if (!commandState.open) return;
  const item = commandState.items[index];
  if (!item) return;
  const text = getInputValue();
  const before = text.slice(0, commandState.start);
  const after = text.slice(commandState.end);
  const insert = item.command + ' ';
  const nextText = before + insert + after;
  const nextCaret = (before + insert).length;
  setInputValue(nextText, nextCaret);
  hideCommandMenu();
  updateSendState();
}

function buildDiffHtml(code) {
  const lines = String(code || '').split('\n');
  const out = lines.map((line) => {
    const escaped = escapeHtml(line);
    if (line.startsWith('+')) return '<span class="diff-line diff-add">' + escaped + '</span>';
    if (line.startsWith('-')) return '<span class="diff-line diff-del">' + escaped + '</span>';
    if (line.startsWith('@@')) return '<span class="diff-line diff-hunk">' + escaped + '</span>';
    return '<span class="diff-line">' + escaped + '</span>';
  });
  return '<pre class="diff-block"><code>' + out.join('\n') + '</code></pre>';
}

function highlightCode(code) {
  let src = escapeHtml(code);
  src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => `<span class="token comment">${m}</span>`);
  src = src.replace(/\/\/.*$/gm, (m) => `<span class="token comment">${m}</span>`);
  src = src.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => `<span class="token string">${m}</span>`);
  src = src.replace(/\b\d+(\.\d+)?\b/g, (m) => `<span class="token number">${m}</span>`);
  src = src.replace(
    /\b(class|function|return|const|let|var|if|else|for|while|switch|case|break|import|export|default|new|try|catch|throw)\b/g,
    (m) => `<span class="token keyword">${m}</span>`
  );
  return src;
}

function wrapCodeLines(html) {
  const lines = html.split('\n');
  return lines.map((line) => {
    const content = line === '' ? '&nbsp;' : line;
    return `<span class="code-line"><span class="line-text">${content}</span></span>`;
  }).join('\n');
}

function stripLineNumberPrefix(code) {
  const lines = String(code || '').split('\n');
  if (!lines.length) return { text: String(code || ''), stripped: false };
  let matches = 0;
  const strippedLines = lines.map((line) => {
    if (/^\s*\d+\s\|\s?/.test(line)) {
      matches += 1;
      return line.replace(/^\s*\d+\s\|\s?/, '');
    }
    return line;
  });
  const isNumbered = matches >= Math.min(3, Math.ceil(lines.length * 0.6));
  if (!isNumbered) return { text: String(code || ''), stripped: false };
  return { text: strippedLines.join('\n'), stripped: true };
}

function isHtmlLanguage(lang) {
  const normalized = String(lang || '').trim().toLowerCase();
  return normalized === 'html' || normalized === 'htm' || normalized === 'xhtml';
}

function isLikelyHtml(code) {
  const trimmed = String(code || '').trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) return true;
  if (trimmed.startsWith('<') && /<\/?[a-z][\s\S]*>/i.test(trimmed)) return true;
  return false;
}

function buildCodeBlockHtml(code, lang) {
  const normalized = stripLineNumberPrefix(code);
  const highlighted = highlightCode(normalized.text);
  const withLines = wrapCodeLines(highlighted);
  const klass = lang ? ' class="code-block language-' + escapeHtml(lang) + '"' : ' class="code-block"';
  const wantsPreview = isHtmlLanguage(lang) || (!lang && isLikelyHtml(normalized.text));
  const encoded = escapeHtml(encodeURIComponent(normalized.text));
  const button = wantsPreview ? '<button class="preview-btn" type="button" aria-label="Preview HTML">Preview</button>' : '';
  const wrapperClass = wantsPreview ? 'code-block-wrapper has-preview' : 'code-block-wrapper';
  return '<div class="' + wrapperClass + '">' + button + '<pre data-code="' + encoded + '"><code' + klass + '>' + withLines + '</code></pre></div>';
}

function isTableSeparator(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || !trimmed.includes('|')) return false;
  return /^(\|?\s*:?-{2,}:?\s*)+\|?$/.test(trimmed);
}

function isTableRow(line) {
  const trimmed = String(line || '').trim();
  return Boolean(trimmed) && trimmed.includes('|');
}

function splitTableRow(line) {
  let trimmed = String(line || '').trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function buildTableHtml(lines) {
  if (!lines.length) return '';
  const headerCells = splitTableRow(lines[0]).map((cell) => escapeHtml(cell || ''));
  const bodyRows = [];
  for (let i = 2; i < lines.length; i += 1) {
    const cells = splitTableRow(lines[i]).map((cell) => escapeHtml(cell || ''));
    if (!cells.length) continue;
    bodyRows.push(cells);
  }
  const thead = '<thead><tr>' + headerCells.map((cell) => `<th>${cell}</th>`).join('') + '</tr></thead>';
  const tbody = bodyRows.length
    ? '<tbody>' + bodyRows.map((row) => '<tr>' + row.map((cell) => `<td>${cell}</td>`).join('') + '</tr>').join('') + '</tbody>'
    : '<tbody></tbody>';
  return `<table class="md-table">${thead}${tbody}</table>`;
}

function renderMarkdown(text) {
  let src = String(text || '').replace(/\r\n/g, '\n');
  const blocks = [];

  src = src.replace(/\x60\x60\x60([\w-]+)?\n([\s\S]*?)\x60\x60\x60/g, (_, lang, code) => {
    const langSafe = String(lang || '').toLowerCase();
    if (langSafe === 'diff' || langSafe === 'patch') {
      const html = buildDiffHtml(code);
      blocks.push(html);
      return '@@BLOCK' + (blocks.length - 1) + '@@';
    }
    const html = buildCodeBlockHtml(code, langSafe);
    blocks.push(html);
    return '@@BLOCK' + (blocks.length - 1) + '@@';
  });

  const tableLines = src.split('\n');
  const processed = [];
  for (let i = 0; i < tableLines.length; i += 1) {
    const line = tableLines[i];
    const nextLine = tableLines[i + 1];
    if (isTableRow(line) && isTableSeparator(nextLine)) {
      const blockLines = [line, nextLine];
      let j = i + 2;
      while (j < tableLines.length && isTableRow(tableLines[j])) {
        blockLines.push(tableLines[j]);
        j += 1;
      }
      const html = buildTableHtml(blockLines);
      blocks.push(html);
      processed.push('@@BLOCK' + (blocks.length - 1) + '@@');
      i = j - 1;
      continue;
    }
    processed.push(line);
  }
  src = processed.join('\n');

  src = escapeHtml(src);

  src = src.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
  src = src.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    const safe = sanitizeUrl(url);
    if (!safe) return label;
    const isInternal = safe.startsWith('codecritic-open:');
    const target = isInternal ? '' : ' target="_blank" rel="noreferrer"';
    return '<a href="' + safe + '"' + target + '>' + label + '</a>';
  });

  const lines = src.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;
  let paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    out.push('<p>' + paragraph.join('<br>') + '</p>');
    paragraph = [];
  }

  function closeLists() {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeLists();
      continue;
    }

    const blockMatch = /^@@BLOCK(\d+)@@$/.exec(trimmed);
    if (blockMatch) {
      flushParagraph();
      closeLists();
      out.push(trimmed);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = heading[1].length;
      out.push('<h' + level + '>' + heading[2] + '</h' + level + '>');
      continue;
    }

    const ul = /^[-*]\s+(.*)$/.exec(trimmed);
    if (ul) {
      flushParagraph();
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul>');
        inUl = true;
      }
      out.push('<li>' + ul[1] + '</li>');
      continue;
    }

    const ol = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (ol) {
      flushParagraph();
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol>');
        inOl = true;
      }
      out.push('<li>' + ol[1] + '</li>');
      continue;
    }

    if (inUl || inOl) {
      closeLists();
    }
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeLists();

  let html = out.join('\n');
  blocks.forEach((block, i) => {
    const key = '@@BLOCK' + i + '@@';
    html = html.replace(key, block);
  });
  return html;
}

function limitText(text, maxLen) {
  const raw = String(text || '');
  const limit = Math.max(20, Number(maxLen || 320));
  if (raw.length <= limit) return raw;
  return raw.slice(0, limit) + '…';
}

function contextLabel(ctx) {
  if (!ctx) return 'Context';
  return ctx.title || ctx.filePath || ctx.kind || 'Context';
}

function contextMeta(ctx) {
  if (!ctx) return '';
  const parts = [];
  if (ctx.filePath) parts.push(ctx.filePath);
  if (ctx.selection) parts.push('lines ' + ctx.selection.startLine + '-' + ctx.selection.endLine);
  if (ctx.languageId) parts.push(ctx.languageId);
  if (ctx.code) parts.push(String(ctx.code).length + ' chars');
  const note = ctx.extraContext || ctx.content;
  if (note) parts.push('notes');
  return parts.join(' • ');
}

function contextNote(ctx) {
  return String(ctx && (ctx.extraContext || ctx.content) || '').trim();
}

function renderContextChips(contexts) {
  if (!contextChips) return;
  contextChips.innerHTML = '';
  const list = Array.isArray(contexts) ? contexts : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = 'No context yet. Add selection or a note to keep it handy.';
    contextChips.appendChild(empty);
    return;
  }
  for (const ctx of list) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.id = String(ctx.id || '');
    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = contextLabel(ctx);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove context');
    remove.dataset.action = 'remove';
    remove.dataset.id = String(ctx.id || '');
    chip.appendChild(label);
    chip.appendChild(remove);
    contextChips.appendChild(chip);
  }
}

function renderContextList(contexts) {
  if (!contextList) return;
  contextList.innerHTML = '';
  const list = Array.isArray(contexts) ? contexts : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'context-empty';
    empty.textContent = 'No contexts yet. Add a selection or a note.';
    contextList.appendChild(empty);
    return;
  }
  for (const ctx of list) {
    const card = document.createElement('div');
    card.className = 'context-card';
    const title = document.createElement('div');
    title.className = 'context-title';
    title.textContent = contextLabel(ctx);
    const meta = document.createElement('div');
    meta.className = 'context-meta';
    meta.textContent = contextMeta(ctx);
    const actions = document.createElement('div');
    actions.className = 'context-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = editingContextId === String(ctx.id) ? 'Cancel' : 'Edit';
    editBtn.dataset.action = 'toggleEdit';
    editBtn.dataset.id = String(ctx.id || '');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.dataset.action = 'remove';
    removeBtn.dataset.id = String(ctx.id || '');
    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);

    card.appendChild(title);
    card.appendChild(meta);

    if (editingContextId === String(ctx.id)) {
      const editor = document.createElement('div');
      editor.className = 'context-editor';
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.value = ctx.title || '';
      titleInput.placeholder = 'Title';
      titleInput.dataset.field = 'title';
      titleInput.dataset.id = String(ctx.id || '');
      const noteInput = document.createElement('textarea');
      noteInput.value = contextNote(ctx);
      noteInput.placeholder = ctx.kind === 'note' ? 'Note content' : 'Notes for this context';
      noteInput.dataset.field = 'note';
      noteInput.dataset.id = String(ctx.id || '');
      const saveRow = document.createElement('div');
      saveRow.className = 'context-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save';
      saveBtn.dataset.action = 'saveEdit';
      saveBtn.dataset.id = String(ctx.id || '');
      saveRow.appendChild(saveBtn);
      editor.appendChild(titleInput);
      editor.appendChild(noteInput);
      editor.appendChild(saveRow);
      card.appendChild(editor);
    } else {
      if (ctx.code) {
        const pre = document.createElement('pre');
        pre.className = 'context-preview';
        pre.textContent = limitText(ctx.code, 500);
        card.appendChild(pre);
      }
      const note = contextNote(ctx);
      if (note) {
        const noteEl = document.createElement('div');
        noteEl.className = 'context-meta';
        noteEl.textContent = 'Notes: ' + limitText(note, 260);
        card.appendChild(noteEl);
      }
    }

    card.appendChild(actions);
    contextList.appendChild(card);
  }
}

function formatApprovalDetails(details) {
  if (Array.isArray(details)) {
    return details.filter(Boolean).join('\n');
  }
  return String(details || '').trim();
}

function sendApprovalResponse(id, approved) {
  if (!id) return false;
  if (!postVsCodeMessage({ type: 'approvalResponse', id, approved })) {
    if (statusEl) statusEl.textContent = 'Unable to send approval response';
    return false;
  }
  return true;
}

function handleApprovalAction(button) {
  if (!button) return false;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (!id || !action) return false;
  const approved = action === 'approve';
  return sendApprovalResponse(id, approved);
}

function buildApprovalBlock(item) {
  const approval = document.createElement('div');
  approval.className = 'tool-approval';
  const header = document.createElement('div');
  header.className = 'approval-header';
  const icon = document.createElement('span');
  icon.className = 'approval-icon';
  icon.textContent = '!';
  const title = document.createElement('span');
  title.textContent = item.title || 'Action required';
  header.appendChild(icon);
  header.appendChild(title);
  approval.appendChild(header);

  const detailText = formatApprovalDetails(item.details);
  if (detailText) {
    const message = document.createElement('div');
    message.className = 'approval-message';
    message.textContent = detailText;
    approval.appendChild(message);
  }

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'danger';
  cancelBtn.textContent = item.cancelLabel || 'Cancel';
  cancelBtn.dataset.action = 'cancel';
  cancelBtn.dataset.id = item.id;
  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'primary';
  approveBtn.textContent = item.approveLabel || 'Approve';
  approveBtn.dataset.action = 'approve';
  approveBtn.dataset.id = item.id;
  actions.appendChild(cancelBtn);
  actions.appendChild(approveBtn);
  approval.appendChild(actions);
  return approval;
}

function renderApprovals() {
  if (!approvalsEl) return;
  approvalsEl.innerHTML = '';
  const approvals = Array.isArray(state.approvals) ? state.approvals : [];
  if (!approvals.length) return;
  for (const item of approvals) {
    const card = document.createElement('div');
    card.className = 'approval-card';
    const title = document.createElement('div');
    title.className = 'approval-title';
    title.textContent = item.title || 'Approval required';
    const details = document.createElement('div');
    details.className = 'approval-details';
    const detailText = formatApprovalDetails(item.details);
    details.textContent = detailText;
    card.appendChild(title);
    if (detailText) card.appendChild(details);
    card.appendChild(buildApprovalBlock(item).querySelector('.approval-actions'));
    approvalsEl.appendChild(card);
  }
}

function renderTodos() {
  if (!todosEl) return;
  todosEl.innerHTML = '';
  const isAgent = state.mode === 'agent';
  const planItems = Array.isArray(state.plan) ? state.plan : [];
  const todoItems = Array.isArray(state.todos) ? state.todos : [];
  const items = isAgent ? todoItems : planItems;
  if (!items.length) return;
  const card = document.createElement('div');
  card.className = 'todo-card';
  const header = document.createElement('div');
  header.className = 'todo-header';
  const title = document.createElement('div');
  title.className = 'todo-title';
  title.textContent = isAgent ? 'Todos' : 'Plan';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'todo-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.title = isAgent ? 'Clear todos' : 'Clear plan';
  header.appendChild(title);
  header.appendChild(closeBtn);
  card.appendChild(header);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'todo-item' + (item.status === 'done' ? ' done' : '');
    const pill = document.createElement('span');
    pill.className = 'todo-pill';
    pill.textContent = item.status === 'done' ? 'Done' : (isAgent ? 'Next' : 'Step');
    const text = document.createElement('span');
    text.textContent = item.text || '';
    row.appendChild(pill);
    row.appendChild(text);
    card.appendChild(row);
  }

  todosEl.appendChild(card);
}

function isToolMessage(content) {
  const text = String(content || '').trim();
  return text.startsWith('Tool call:') || text.startsWith('Tool result');
}

function extractRevertMeta(text) {
  let revertId = '';
  let cleaned = String(text || '');
  cleaned = cleaned.replace(/\[\[revert:([a-zA-Z0-9_-]+)\]\]/g, (_, id) => {
    if (!revertId) revertId = String(id || '').trim();
    return '';
  });
  return { text: cleaned.trim(), revertId };
}

function buildToolBlock(contents, approvalItem) {
  const items = Array.isArray(contents) ? contents : [contents];
  const text = String(items[0] || '');
  const lines = text.split('\n');
  const summaryText = lines[0] ? lines[0].trim() : 'Tool';
  const rawBody = items
    .map((item) => String(item || '').split('\n').slice(1).join('\n').trim())
    .filter(Boolean)
    .join('\n\n');
  const meta = extractRevertMeta(rawBody);
  const bodyText = meta.text;
  const details = document.createElement('details');
  details.className = 'tool-block';
  const summary = document.createElement('summary');
  const summaryTitle = document.createElement('span');
  summaryTitle.className = 'tool-summary-title';
  summaryTitle.textContent = summaryText || 'Tool';
  summary.appendChild(summaryTitle);
  if (approvalItem) {
    details.classList.add('is-pending');
    const status = document.createElement('span');
    status.className = 'tool-status-badge pending';
    status.textContent = 'Awaiting approval';
    summary.appendChild(status);
  }
  if (summaryText.startsWith('Tool call: run_command')) {
    const cmdMatch = /- command:\s*`([^`]+)`/m.exec(text);
    const cmd = cmdMatch ? cmdMatch[1] : '';
    if (cmd) {
      const summaryMeta = document.createElement('div');
      summaryMeta.className = 'tool-summary-meta';
      summaryMeta.textContent = cmd;
      summary.appendChild(summaryMeta);
    }
  }
  const body = document.createElement('div');
  body.className = 'tool-body';
  if (meta.revertId) {
    const actions = document.createElement('div');
    actions.className = 'tool-actions';
    const revertBtn = document.createElement('button');
    revertBtn.className = 'tool-revert';
    revertBtn.type = 'button';
    revertBtn.textContent = 'Revert';
    revertBtn.dataset.revertId = meta.revertId;
    actions.appendChild(revertBtn);
    body.appendChild(actions);
  }
  const content = document.createElement('div');
  content.className = 'tool-content';
  if (bodyText) {
    content.innerHTML = renderMarkdown(bodyText);
  } else {
    content.textContent = '';
  }
  body.appendChild(content);
  details.appendChild(summary);
  details.appendChild(body);
  if (approvalItem) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tool-block-wrapper';
    const footer = document.createElement('div');
    footer.className = 'tool-approval-footer';
    footer.appendChild(buildApprovalBlock(approvalItem));
    wrapper.appendChild(details);
    wrapper.appendChild(footer);
    return wrapper;
  }
  return details;
}

function renderMessages(messages) {
  chatEl.innerHTML = '';
  const pendingApprovals = Array.isArray(state.approvals) ? [...state.approvals] : [];
  for (let i = 0; i < (messages || []).length; i += 1) {
    const msg = messages[i];
    const div = document.createElement('div');
    div.className = 'msg ' + (msg.role === 'user' ? 'user' : 'assistant');
    const content = msg.content || '';
    if (isToolMessage(content)) {
      div.classList.add('msg-tool-call');
      const group = [content];
      let j = i + 1;
      const isToolCall = String(content || '').trim().startsWith('Tool call:');
      while (j < messages.length) {
        const next = messages[j];
        if (!next || next.role !== 'assistant' || !isToolMessage(next.content || '')) break;
        const nextIsCall = String(next.content || '').trim().startsWith('Tool call:');
        if (nextIsCall && isToolCall) break;
        if (nextIsCall && !isToolCall) break;
        group.push(next.content || '');
        j += 1;
      }
      const approvalItem = isToolCall && pendingApprovals.length ? pendingApprovals.shift() : null;
      div.appendChild(buildToolBlock(group, approvalItem));
      i = j - 1;
    } else if (msg.role === 'assistant') {
      div.innerHTML = renderMarkdown(content);
    } else {
      div.textContent = content;
    }
    chatEl.appendChild(div);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function updateSendState() {
  const hasText = Boolean(getInputValue().trim());
  sendBtn.disabled = state.busy || !hasText;
  if (sendBtn) {
    sendBtn.classList.toggle('is-thinking', Boolean(state.busy));
  }
  if (stopBtn) {
    stopBtn.classList.toggle('is-visible', Boolean(state.busy));
    stopBtn.disabled = !state.busy;
  }
}

function updateContextNoteState() {
  if (!addContextNoteBtn) return;
  const hasText = Boolean(contextNoteInput && contextNoteInput.value.trim());
  addContextNoteBtn.disabled = state.busy || !hasText;
}

function setActiveTab(tab) {
  activeTab = tab === 'context' ? 'context' : 'chat';
  if (tabChat) tabChat.classList.toggle('active', activeTab === 'chat');
  if (tabContext) tabContext.classList.toggle('active', activeTab === 'context');
  for (const btn of tabButtons) {
    const isActive = btn.dataset.tab === activeTab;
    btn.classList.toggle('active', isActive);
  }
}

function renderModelSelect() {
  if (!modelSelect) return;
  const models = Array.isArray(state.models) ? state.models : [];
  const active = String(state.activeModel || '').trim();
  const unique = [];
  for (const name of models) {
    const trimmed = String(name || '').trim();
    if (!trimmed) continue;
    if (!unique.includes(trimmed)) unique.push(trimmed);
  }
  if (active && !unique.includes(active)) unique.unshift(active);
  modelSelect.innerHTML = '';
  for (const model of unique) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    if (model === active) opt.selected = true;
    modelSelect.appendChild(opt);
  }
  const manageOpt = document.createElement('option');
  manageOpt.value = '__manage__';
  manageOpt.textContent = 'Manage models...';
  modelSelect.appendChild(manageOpt);
  if (active && unique.includes(active)) {
    modelSelect.value = active;
  } else if (unique.length) {
    modelSelect.value = unique[0];
  }
  modelSelect.disabled = state.busy;
}

function render(nextState) {
  state = nextState || state;
  modeEl.value = state.mode || 'chat';
  if (debugToggleBtn) {
    const enabled = Boolean(state.debugListenEnabled);
    debugToggleBtn.classList.toggle('is-active', enabled);
    debugToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    debugToggleBtn.title = enabled
      ? 'Debug snapshot listening on'
      : 'Debug snapshot listening off';
  }
  const contexts = Array.isArray(state.contexts) ? state.contexts : [];
  const countText = `${contexts.length} context${contexts.length === 1 ? '' : 's'}`;
  if (contextCount) contextCount.textContent = countText;
  if (contextCountDetail) contextCountDetail.textContent = countText;
  if (clearContextBtn) clearContextBtn.disabled = contexts.length === 0;
  if (clearContextAllBtn) clearContextAllBtn.disabled = contexts.length === 0;
  if (editingContextId && !contexts.some((ctx) => String(ctx.id) === String(editingContextId))) {
    editingContextId = null;
  }
  renderContextChips(contexts);
  renderContextList(contexts);
  renderTodos();
  renderApprovals();
  const approvals = Array.isArray(state.approvals) ? state.approvals : [];
  if (statusEl) {
    if (approvals.length) {
      statusEl.textContent = 'Approval required';
    } else {
      statusEl.textContent = state.busy ? 'Thinking...' : '';
    }
  }
  const threads = Array.isArray(state.threads) ? state.threads : [];
  if (threadSelect) {
    threadSelect.innerHTML = '';
    for (const thread of threads) {
      const opt = document.createElement('option');
      opt.value = thread.id;
      opt.textContent = thread.title || 'Chat';
      if (thread.id === state.activeThreadId) opt.selected = true;
      threadSelect.appendChild(opt);
    }
    threadSelect.disabled = state.busy || threads.length === 0;
  }
  renderModelSelect();
  if (newChatBtn) {
    newChatBtn.disabled = state.busy;
  }
  renderMessages(state.messages);
  updateSendState();
  updateContextNoteState();
  setActiveTab(activeTab);
}

function send() {
  const text = getInputValue().trim();
  if (!text) return;
  if (statusEl) statusEl.textContent = 'Sending...';
  logUi('send clicked');
  if (sendBtn) sendBtn.classList.add('is-thinking');
  if (!postVsCodeMessage({ type: 'send', text })) {
    if (statusEl) statusEl.textContent = 'Unable to post message to extension';
  }
  if (inputEl) inputEl.innerHTML = '';
  hideCommandMenu();
  updateSendState();
}

function parseOpenFileLink(href) {
  if (!href || !href.startsWith('codecritic-open:')) return null;
  const payload = href.slice('codecritic-open:'.length);
  if (!payload) return null;
  const [pathPart, linePart] = payload.split('#');
  const path = decodeURIComponent(pathPart || '');
  const line = linePart ? Number(linePart) : 1;
  if (!path) return null;
  return { path, line: Number.isFinite(line) ? line : 1 };
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'ping') {
    if (statusEl) statusEl.textContent = 'Ping received';
    logUi('ping received');
    return;
  }
  if (msg && msg.type === 'state') {
    render(msg.state);
    if (msg.stateId) {
      postVsCodeMessage({ type: 'stateAck', stateId: msg.stateId });
    }
    return;
  }
  if (msg && msg.type === 'approval') {
    return;
  }
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!target) return;

  const previewBtn = target.closest('.preview-btn');
  if (previewBtn) {
    const wrapper = previewBtn.closest('.code-block-wrapper');
    const pre = wrapper ? wrapper.querySelector('pre[data-code]') : null;
    const encoded = pre && pre.dataset ? pre.dataset.code : '';
    if (encoded) {
      let decoded = '';
      try {
        decoded = decodeURIComponent(encoded);
      } catch {
        decoded = encoded;
      }
      if (decoded) {
        postVsCodeMessage({ type: 'previewHtml', code: decoded });
      }
    }
    return;
  }

  const todoClose = target.closest('button.todo-close');
  if (todoClose) {
    if (!postVsCodeMessage({ type: 'clearTodos' })) {
      const label = state.mode === 'agent' ? 'todos' : 'plan';
      if (statusEl) statusEl.textContent = `Unable to clear ${label}`;
    }
    return;
  }
  const revertBtn = target.closest('button.tool-revert');
  if (revertBtn) {
    const id = revertBtn.dataset.revertId;
    if (!id) return;
    revertBtn.disabled = true;
    if (!postVsCodeMessage({ type: 'revertChange', id })) {
      revertBtn.disabled = false;
      if (statusEl) statusEl.textContent = 'Unable to revert change';
    }
    return;
  }
  const link = target.closest('a');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || !href.startsWith('codecritic-open:')) return;
  event.preventDefault();
  const payload = parseOpenFileLink(href);
  if (!payload) return;
  if (!postVsCodeMessage({ type: 'openFile', ...payload })) {
    if (statusEl) statusEl.textContent = 'Unable to open file';
  }
});

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    setActiveTab(btn.dataset.tab || 'chat');
  });
}

if (contextChips) {
  contextChips.addEventListener('click', (event) => {
    const target = event.target;
    if (!target) return;
    const removeBtn = target.closest('button[data-action="remove"]');
    if (removeBtn) {
      const id = removeBtn.dataset.id;
      if (!postVsCodeMessage({ type: 'removeContext', id })) {
        if (statusEl) statusEl.textContent = 'Unable to remove context';
      }
      return;
    }
    const chip = target.closest('.chip');
    if (chip && chip.dataset && chip.dataset.id) {
      editingContextId = String(chip.dataset.id);
      setActiveTab('context');
      render(state);
    }
  });
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!target) return;
  const button = target.closest('button[data-action="approve"], button[data-action="cancel"]');
  if (button && handleApprovalAction(button)) {
    event.preventDefault();
  }
});

if (contextList) {
  contextList.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.dataset) return;
    const action = target.dataset.action;
    if (!action) return;
    const id = target.dataset.id;
    if (action === 'remove') {
      if (!postVsCodeMessage({ type: 'removeContext', id })) {
        if (statusEl) statusEl.textContent = 'Unable to remove context';
      }
      return;
    }
    if (action === 'toggleEdit') {
      editingContextId = editingContextId === String(id) ? null : String(id);
      render(state);
      return;
    }
    if (action === 'saveEdit') {
      const titleInput = contextList.querySelector('input[data-id="' + id + '"][data-field="title"]');
      const noteInput = contextList.querySelector('textarea[data-id="' + id + '"][data-field="note"]');
      const title = titleInput ? titleInput.value : '';
      const note = noteInput ? noteInput.value : '';
      const ctx = (Array.isArray(state.contexts) ? state.contexts : []).find((item) => String(item.id) === String(id));
      const payload = { type: 'updateContext', id };
      if (typeof title === 'string') payload.title = title;
      if (ctx && ctx.kind === 'note') {
        payload.content = note;
      } else {
        payload.extraContext = note;
      }
      if (!postVsCodeMessage(payload)) {
        if (statusEl) statusEl.textContent = 'Unable to update context';
      }
      editingContextId = null;
      return;
    }
  });
}

modeEl.addEventListener('change', () => {
  if (!postVsCodeMessage({ type: 'setMode', mode: modeEl.value })) {
    if (statusEl) statusEl.textContent = 'Unable to update mode';
  }
});

if (threadSelect) {
  threadSelect.addEventListener('change', () => {
    const selected = threadSelect.value;
    if (selected) {
      if (!postVsCodeMessage({ type: 'selectThread', threadId: selected })) {
        if (statusEl) statusEl.textContent = 'Unable to select thread';
      }
    }
  });
}

if (modelSelect) {
  modelSelect.addEventListener('change', () => {
    const selected = modelSelect.value;
    if (!selected) return;
    if (selected === '__manage__') {
      if (!postVsCodeMessage({ type: 'manageModel' })) {
        if (statusEl) statusEl.textContent = 'Unable to manage models';
      }
      render(state);
      return;
    }
    if (!postVsCodeMessage({ type: 'setModel', model: selected })) {
      if (statusEl) statusEl.textContent = 'Unable to select model';
    }
  });
}

if (newChatBtn) {
  newChatBtn.addEventListener('click', () => {
    if (!postVsCodeMessage({ type: 'newThread' })) {
      if (statusEl) statusEl.textContent = 'Unable to create new chat';
    }
  });
}

if (debugToggleBtn) {
  debugToggleBtn.addEventListener('click', () => {
    const enabled = !state.debugListenEnabled;
    if (!postVsCodeMessage({ type: 'toggleDebugListen', enabled })) {
      if (statusEl) statusEl.textContent = 'Unable to toggle debug listening';
    }
  });
}

if (commandMenu) {
  commandMenu.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (!target) return;
    const item = target.closest('.command-item');
    if (!item) return;
    event.preventDefault();
    const idx = Number(item.dataset.index);
    applyCommandSelection(Number.isFinite(idx) ? idx : 0);
  });
}

if (addContextFromSelectionBtn) {
  addContextFromSelectionBtn.addEventListener('click', () => {
    if (!postVsCodeMessage({ type: 'addContextFromSelection' })) {
      if (statusEl) statusEl.textContent = 'Unable to add context';
    }
  });
}

if (addContextFromSelectionDetailBtn) {
  addContextFromSelectionDetailBtn.addEventListener('click', () => {
    if (!postVsCodeMessage({ type: 'addContextFromSelection' })) {
      if (statusEl) statusEl.textContent = 'Unable to add context';
    }
  });
}

if (clearContextBtn) {
  clearContextBtn.addEventListener('click', () => {
    if (!postVsCodeMessage({ type: 'clearContext' })) {
      if (statusEl) statusEl.textContent = 'Unable to clear context';
    }
  });
}

if (clearContextAllBtn) {
  clearContextAllBtn.addEventListener('click', () => {
    if (!postVsCodeMessage({ type: 'clearContext' })) {
      if (statusEl) statusEl.textContent = 'Unable to clear context';
    }
  });
}

if (addContextNoteBtn) {
  addContextNoteBtn.addEventListener('click', () => {
    const text = contextNoteInput ? contextNoteInput.value.trim() : '';
    if (!text) {
      if (statusEl) statusEl.textContent = 'Add a note before saving.';
      return;
    }
    if (!postVsCodeMessage({ type: 'addContextManual', content: text })) {
      if (statusEl) statusEl.textContent = 'Unable to add context note';
      return;
    }
    if (contextNoteInput) contextNoteInput.value = '';
    updateContextNoteState();
  });
}

if (contextNoteInput) {
  contextNoteInput.addEventListener('input', updateContextNoteState);
  contextNoteInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (addContextNoteBtn && !addContextNoteBtn.disabled) {
        addContextNoteBtn.click();
      }
    }
  });
}

sendBtn.addEventListener('click', send);
if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    if (!postVsCodeMessage({ type: 'stop' })) {
      if (statusEl) statusEl.textContent = 'Unable to stop';
    }
  });
}
if (inputEl) {
  inputEl.addEventListener('compositionstart', () => {
    composing = true;
  });
  inputEl.addEventListener('compositionend', () => {
    composing = false;
    renderRichInput();
    updateCommandMenu();
    updateSendState();
  });
  inputEl.addEventListener('input', () => {
    if (composing) return;
    renderRichInput();
    updateCommandMenu();
    updateSendState();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (commandState.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = commandState.items.length
        ? (commandState.activeIndex + delta + commandState.items.length) % commandState.items.length
        : 0;
      commandState.activeIndex = next;
      renderCommandMenu(commandState.items, commandState.activeIndex);
      return;
    }
    if (commandState.open && e.key === 'Tab') {
      e.preventDefault();
      applyCommandSelection(commandState.activeIndex);
      return;
    }
    if (commandState.open && e.key === 'Escape') {
      e.preventDefault();
      hideCommandMenu();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener('click', () => {
    updateCommandMenu();
  });
  inputEl.addEventListener('blur', () => {
    setTimeout(() => hideCommandMenu(), 120);
  });
  inputEl.addEventListener('paste', (e) => {
    const data = e.clipboardData || window.clipboardData;
    const text = data ? data.getData('text/plain') : '';
    if (!text) return;
    e.preventDefault();
    let handled = false;
    try {
      handled = typeof document.execCommand === 'function'
        ? document.execCommand('insertText', false, text)
        : false;
    } catch {
      handled = false;
    }
    if (!handled) {
      insertPlainTextAtCursor(inputEl, text);
    }
    renderRichInput();
    updateCommandMenu();
    updateSendState();
  });
}

if (statusEl) statusEl.textContent = 'Chat UI ready';
logUi('webview ready');
if (!postVsCodeMessage({ type: 'ready' })) {
  if (statusEl) statusEl.textContent = 'Unable to initialize chat';
}
