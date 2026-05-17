import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'conversations.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      nome TEXT,
      estagio TEXT DEFAULT 'novo_contato',
      proximo_agente TEXT DEFAULT 'recepcao',
      lgpd_consentido INTEGER DEFAULT 0,
      dados JSON DEFAULT '{}',
      agendamento_confirmado INTEGER DEFAULT 0,
      sheets_salvo INTEGER DEFAULT 0,
      calendar_salvo INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export function getHistory(phone, limit = 10) {
  return getDb()
    .prepare(`
      SELECT role, content FROM conversations
      WHERE phone = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(phone, limit)
    .reverse();
}

export function saveMessage(phone, role, content, agent = null) {
  getDb()
    .prepare(`INSERT INTO conversations (phone, role, content, agent) VALUES (?, ?, ?, ?)`)
    .run(phone, role, content, agent);
}

export function getLead(phone) {
  return getDb().prepare(`SELECT * FROM leads WHERE phone = ?`).get(phone);
}

export function upsertLead(phone, updates = {}) {
  const existing = getLead(phone);
  if (!existing) {
    getDb()
      .prepare(`INSERT INTO leads (phone) VALUES (?)`)
      .run(phone);
  }

  const fields = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(', ');

  if (!fields) return getLead(phone);

  getDb()
    .prepare(`UPDATE leads SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE phone = ?`)
    .run(...Object.values(updates), phone);

  return getLead(phone);
}

export function mergeDados(phone, novosDados = {}) {
  const lead = getLead(phone) || {};
  const dadosAtuais = JSON.parse(lead.dados || '{}');
  const dadosMerged = { ...dadosAtuais, ...novosDados };
  upsertLead(phone, { dados: JSON.stringify(dadosMerged) });
  return dadosMerged;
}
