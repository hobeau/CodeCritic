function safeJsonParse(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function extractFirstJsonPayload(text) {
  const str = String(text || '');
  const objStart = str.indexOf('{');
  const objEnd = str.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    return str.slice(objStart, objEnd + 1);
  }
  const arrStart = str.indexOf('[');
  const arrEnd = str.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    return str.slice(arrStart, arrEnd + 1);
  }
  return '';
}

function extractAssistantText(json) {
  if (!json || typeof json !== 'object') return '';
  const choices = Array.isArray(json.choices) ? json.choices : [];
  if (!choices.length) return '';
  const message = choices[0] && choices[0].message ? choices[0].message : null;
  if (message && typeof message.content === 'string') return message.content;
  if (choices[0] && typeof choices[0].text === 'string') return choices[0].text;
  if (json.message && typeof json.message.content === 'string') return json.message.content;
  if (typeof json.response === 'string') return json.response;
  if (typeof json.content === 'string') return json.content;
  return '';
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function postChatCompletions(url, body, options = {}) {
  const timeoutMs = 120000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let onAbort = null;
  if (options.signal) {
    if (options.signal.aborted) {
      ac.abort();
    } else {
      onAbort = () => ac.abort();
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    });

    if (!res.ok) {
      const txt = await safeReadText(res);
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
    }

    return await res.json();
  } finally {
    clearTimeout(t);
    if (onAbort && options.signal) {
      try { options.signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  safeJsonParse,
  extractFirstJsonPayload,
  extractAssistantText,
  safeReadText,
  postChatCompletions
};
