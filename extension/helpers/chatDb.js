const vscode = require('vscode');
const path = require('path');
const { getOutputChannel } = require('./output');
const { safeJsonParse } = require('./llm');

let sqlite3;
try {
  sqlite3 = require('sqlite3');
} catch {
  sqlite3 = null;
}

/**
 * Chat database manager for thread and message persistence.
 * Throws errors for chat.js to handle with user-friendly messages.
 */
class ChatDatabase {
  constructor() {
    /** @type {import('sqlite3').Database | undefined} */
    this.db = undefined;
    /** @type {Promise<void> | undefined} */
    this.initPromise = undefined;
    this.unavailable = false;
  }

  /**
   * Check if sqlite3 is available.
   * @throws {Error} If sqlite3 is not available
   */
  ensureSqliteAvailable() {
    if (this.unavailable) {
      throw new Error('sqlite3 dependency not available. Run npm install in the extension folder.');
    }
    if (!sqlite3) {
      this.unavailable = true;
      throw new Error('sqlite3 dependency not available. Run npm install in the extension folder.');
    }
  }

  /**
   * Initialize the database.
   * @param {vscode.ExtensionContext} context - Extension context for storage path
   * @returns {Promise<string|null>} Stored active thread ID or null
   */
  async initialize(context) {
    this.ensureSqliteAvailable();
    
    if (!this.initPromise) {
      this.initPromise = this._initDatabase(context);
    }
    
    await this.initPromise;
    
    // Return stored active thread ID
    const storedId = context.globalState.get('codeCritic.activeChatThreadId');
    return storedId ? String(storedId) : null;
  }

  /**
   * Internal database initialization logic.
   * @private
   */
  async _initDatabase(context) {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const dbPath = path.join(context.globalStorageUri.fsPath, 'chat.db');
    
    this.db = new sqlite3.Database(dbPath);
    
    await this.run('PRAGMA foreign_keys = ON');
    await this.run('PRAGMA journal_mode = WAL');
    
    // Create tables
    await this.run(
      'CREATE TABLE IF NOT EXISTS chat_threads (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'title TEXT NOT NULL,' +
        'context_json TEXT,' +
        'plan_json TEXT,' +
        'created_at TEXT NOT NULL,' +
        'updated_at TEXT NOT NULL' +
      ')'
    );
    
    await this.run(
      'CREATE TABLE IF NOT EXISTS chat_messages (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'thread_id INTEGER NOT NULL,' +
        'role TEXT NOT NULL,' +
        'content TEXT NOT NULL,' +
        'created_at TEXT NOT NULL,' +
        'FOREIGN KEY(thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE' +
      ')'
    );
    
    await this.run('CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON chat_messages(thread_id)');

    // Run migrations
    try {
      const columns = await this.all("PRAGMA table_info('chat_threads')");
      const hasPlan = columns.some((col) => col && col.name === 'plan_json');
      if (!hasPlan) {
        await this.run('ALTER TABLE chat_threads ADD COLUMN plan_json TEXT');
      }
    } catch {
      // Ignore migration errors
    }
  }

  /**
   * Ensure database is ready for use.
   * @throws {Error} If initialization fails
   */
  async ensureReady() {
    if (!this.initPromise) {
      throw new Error('ChatDatabase not initialized. Call initialize() first.');
    }
    
    try {
      await this.initPromise;
    } catch (err) {
      const out = getOutputChannel();
      out.appendLine(`CodeCritic chat DB init failed: ${String(err && err.message ? err.message : err)}`);
      out.show(true);
      throw err;
    }
  }

  /**
   * Execute a SQL command.
   * @param {string} sql - SQL command
   * @param {Array} params - Parameters
   * @returns {Promise<any>} Result with lastID for inserts
   * @throws {Error} If command fails
   */
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject(new Error('Chat DB not initialized.'));
      }
      this.db.run(sql, params, function(err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  /**
   * Get a single row from the database.
   * @param {string} sql - SQL query
   * @param {Array} params - Parameters
   * @returns {Promise<any>} Single row or undefined
   * @throws {Error} If query fails
   */
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject(new Error('Chat DB not initialized.'));
      }
      this.db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  /**
   * Get all rows from the database.
   * @param {string} sql - SQL query
   * @param {Array} params - Parameters
   * @returns {Promise<Array>} Array of rows
   * @throws {Error} If query fails
   */
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject(new Error('Chat DB not initialized.'));
      }
      this.db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  }

  /**
   * Close the database connection.
   */
  dispose() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore
      }
      this.db = undefined;
    }
  }

  /**
   * Generate a default chat title with timestamp.
   * @returns {string}
   */
  defaultChatTitle() {
    const iso = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    return `Chat ${iso}`;
  }

  /**
   * Check if a title is a default chat title.
   * @param {string} title
   * @returns {boolean}
   */
  isDefaultChatTitle(title) {
    const trimmed = String(title || '').trim();
    return trimmed === 'Chat' || trimmed.startsWith('Chat ');
  }

  /**
   * Escape SQL LIKE pattern special characters.
   * @param {string} value
   * @returns {string}
   */
  escapeSqlLike(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  /**
   * Normalize thread ID to a valid string or null.
   * @param {any} value
   * @returns {string|null}
   */
  normalizeThreadId(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return String(Math.floor(num));
  }

  /**
   * Refresh and return all threads.
   * @returns {Promise<Array<{id: string, title: string, updatedAt: string}>>}
   */
  async refreshThreads() {
    const rows = await this.all(
      'SELECT id, title, updated_at FROM chat_threads ORDER BY datetime(updated_at) DESC, id DESC'
    );
    return rows.map((row) => ({
      id: String(row.id),
      title: row.title || this.defaultChatTitle(),
      updatedAt: String(row.updated_at || '')
    }));
  }

  /**
   * Query threads by filter text.
   * @param {string} filter
   * @returns {Promise<Array<{id: string, title: string, updatedAt: string}>>}
   */
  async queryThreadsByFilter(filter) {
    const trimmed = String(filter || '').trim();
    if (!trimmed) return [];
    
    const like = `%${this.escapeSqlLike(trimmed)}%`;
    const sql =
      'SELECT DISTINCT t.id, t.title, t.updated_at ' +
      'FROM chat_threads t ' +
      'LEFT JOIN chat_messages m ON m.thread_id = t.id ' +
      'WHERE t.title LIKE ? ESCAPE \'\\\\\' ' +
      'OR t.context_json LIKE ? ESCAPE \'\\\\\' ' +
      'OR t.plan_json LIKE ? ESCAPE \'\\\\\' ' +
      'OR m.content LIKE ? ESCAPE \'\\\\\' ' +
      'ORDER BY datetime(t.updated_at) DESC, t.id DESC';
    
    const rows = await this.all(sql, [like, like, like, like]);
    return rows.map((row) => ({
      id: String(row.id),
      title: row.title || this.defaultChatTitle(),
      updatedAt: String(row.updated_at || '')
    }));
  }

  /**
   * Create a new chat thread.
   * @param {Object} options
   * @param {string} options.title
   * @param {any} options.context
   * @param {Array} options.plan
   * @returns {Promise<string>} New thread ID
   */
  async createThread({ title, context, plan }) {
    const now = new Date().toISOString();
    const safeTitle = String(title || this.defaultChatTitle()).trim() || this.defaultChatTitle();
    const ctxJson = context ? JSON.stringify(context) : null;
    const planJson = plan && plan.length ? JSON.stringify(plan) : null;
    
    const info = await this.run(
      'INSERT INTO chat_threads (title, context_json, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [safeTitle, ctxJson, planJson, now, now]
    );
    
    const id = info && info.lastID ? String(info.lastID) : null;
    if (!id) {
      throw new Error('Failed to create chat thread: no ID returned');
    }
    
    return id;
  }

  /**
   * Load a chat thread with messages.
   * @param {string} threadId
   * @returns {Promise<{messages: Array, contexts: Array, plan: Array}|null>}
   */
  async loadThread(threadId) {
    const normId = this.normalizeThreadId(threadId);
    if (!normId) return null;
    
    const row = await this.get(
      'SELECT id, title, context_json, plan_json FROM chat_threads WHERE id = ?',
      [normId]
    );
    if (!row) return null;
    
    const rows = await this.all(
      'SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id ASC',
      [normId]
    );
    
    const messages = rows.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: String(msg.content || '')
    }));
    
    const parsed = row.context_json ? safeJsonParse(row.context_json) : null;
    const contexts = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    
    const planParsed = row.plan_json ? safeJsonParse(row.plan_json) : null;
    const plan = Array.isArray(planParsed) ? planParsed : [];
    
    return { messages, contexts, plan };
  }

  /**
   * Delete a chat thread.
   * @param {string} threadId
   */
  async deleteThread(threadId) {
    const normId = this.normalizeThreadId(threadId);
    if (!normId) return;
    
    await this.run('DELETE FROM chat_threads WHERE id = ?', [normId]);
  }

  /**
   * Clear messages from a thread.
   * @param {string} threadId
   */
  async clearMessages(threadId) {
    const normId = this.normalizeThreadId(threadId);
    if (!normId) return;
    
    await this.run('DELETE FROM chat_messages WHERE thread_id = ?', [normId]);
  }

  /**
   * Update thread context.
   * @param {string} threadId
   * @param {any} context
   */
  async updateThreadContext(threadId, context) {
    const normId = this.normalizeThreadId(threadId);
    if (!normId) return;
    
    const ctxJson = context ? JSON.stringify(context) : null;
    await this.run('UPDATE chat_threads SET context_json = ? WHERE id = ?', [ctxJson, normId]);
  }

  /**
   * Update thread plan.
   * @param {string} threadId
   * @param {Array} plan
   */
  async updateThreadPlan(threadId, plan) {
    const normId = this.normalizeThreadId(threadId);
    if (!normId) return;
    
    const planJson = plan && plan.length ? JSON.stringify(plan) : null;
    await this.run('UPDATE chat_threads SET plan_json = ? WHERE id = ?', [planJson, normId]);
  }

  /**
   * Touch thread to update its timestamp.
   * @param {string} threadId
   */
  async touchThread(threadId) {
    const normId = this.normalizeThreadId(threadId);
    if (!normId) return;
    
    const now = new Date().toISOString();
    await this.run('UPDATE chat_threads SET updated_at = ? WHERE id = ?', [now, normId]);
  }

  /**
   * Add a message to a thread.
   * @param {string} threadId
   * @param {string} role
   * @param {string} content
   */
  async addMessage(threadId, role, content) {
    const normId = this.normalizeThreadId(threadId);
    if (!normId) return;
    
    const now = new Date().toISOString();
    await this.run(
      'INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)',
      [normId, role, String(content || ''), now]
    );
  }

  /**
   * Maybe update thread title from message if it's still default.
   * @param {string} threadId
   * @param {string} message
   */
  async maybeUpdateThreadTitle(threadId, message) {
    const normId = this.normalizeThreadId(threadId);
    if (!normId) return;
    
    const row = await this.get('SELECT title FROM chat_threads WHERE id = ?', [normId]);
    if (!row || !row.title) return;
    if (!this.isDefaultChatTitle(row.title)) return;
    
    const candidate = String(message || '').trim();
    if (!candidate) return;
    
    const title = candidate.length > 60 ? `${candidate.slice(0, 57)}...` : candidate;
    await this.run('UPDATE chat_threads SET title = ? WHERE id = ?', [title, normId]);
  }

  /**
   * Persist active thread ID to extension global state.
   * @param {vscode.ExtensionContext} context
   * @param {string|null} threadId
   */
  async persistActiveThreadId(context, threadId) {
    await context.globalState.update('codeCritic.activeChatThreadId', threadId);
  }

  /**
   * Get active thread title from threads array.
   * @param {string} activeThreadId
   * @param {Array} threads
   * @param {Array|null} threadResults
   * @returns {string}
   */
  getActiveThreadTitle(activeThreadId, threads, threadResults) {
    const activeId = activeThreadId ? String(activeThreadId) : '';
    const thread = threads.find((item) => String(item.id) === activeId)
      || (Array.isArray(threadResults) ? threadResults.find((item) => String(item.id) === activeId) : null);
    return thread && thread.title ? thread.title : 'Chat';
  }
}

module.exports = { ChatDatabase };
