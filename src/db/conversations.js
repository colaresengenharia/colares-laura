import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Caminho configurável via env var. Em produção (Railway) defina DB_PATH=/data/conversations.db
// e configure um Volume montado em /data para persistência entre deploys.
// Em desenvolvimento local, cai no caminho default na raiz do projeto.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'conversations.db');

// Garante que o diretório pai existe (necessário pra Railway Volume na 1ª inicialização)
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}
console.log(`[DB] Usando banco em: ${DB_PATH}`);

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
  const d = getDb();
  d.exec(`
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

  // Migrations idempotentes (ALTER se a coluna ainda não existir)
  const cols = d.prepare(`PRAGMA table_info(leads)`).all().map((c) => c.name);
  const addCol = (name, def) => {
    if (!cols.includes(name)) d.exec(`ALTER TABLE leads ADD COLUMN ${name} ${def}`);
  };
  addCol('tentativas_reativacao', 'INTEGER DEFAULT 0');
  addCol('ultima_reativacao_em', 'DATETIME');
  addCol('lembrete_enviado', 'INTEGER DEFAULT 0');
  addCol('desistido', 'INTEGER DEFAULT 0');
  addCol('sheets_row', 'INTEGER');
  addCol('calendar_event_id', 'TEXT');
  addCol('transferido_humano_em', 'DATETIME');
}

export function getUltimaMensagemUserEm(phone) {
  const row = getDb()
    .prepare(`
      SELECT created_at FROM conversations
      WHERE phone = ? AND role = 'user'
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(phone);
  return row?.created_at ?? null;
}

export function listLeadsParaReativar() {
  // Leads que não fecharam agendamento, não desistiram, e ainda têm tentativas disponíveis
  return getDb()
    .prepare(`
      SELECT * FROM leads
      WHERE agendamento_confirmado = 0
        AND desistido = 0
        AND tentativas_reativacao < 2
    `)
    .all();
}

export function listLeadsParaLembrete() {
  return getDb()
    .prepare(`
      SELECT * FROM leads
      WHERE agendamento_confirmado = 1
        AND lembrete_enviado = 0
    `)
    .all();
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
