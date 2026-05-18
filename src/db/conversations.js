import pkg from 'pg';
const { Pool } = pkg;

// Conexão com PostgreSQL via DATABASE_URL.
// No Railway: a variável é injetada automaticamente quando o serviço Postgres é adicionado ao projeto.
let pool;
let schemaPromise = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL não configurada — adicione um serviço PostgreSQL ao projeto Railway');
    }
    // Railway conexão interna não precisa SSL; externa sim. Por segurança, ssl ligado com rejectUnauthorized:false.
    const isInternal = /\.railway\.internal/.test(process.env.DATABASE_URL);
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isInternal ? false : { rejectUnauthorized: false },
      max: 5, // pool pequeno (servidor leve)
    });
    pool.on('error', (err) => console.error('[DB] Pool error:', err));
    console.log('[DB] Pool PostgreSQL inicializado');
  }
  return pool;
}

async function initSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const p = getPool();

    await p.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        nome TEXT,
        estagio TEXT DEFAULT 'novo_contato',
        proximo_agente TEXT DEFAULT 'recepcao',
        lgpd_consentido INTEGER DEFAULT 0,
        dados TEXT DEFAULT '{}',
        agendamento_confirmado INTEGER DEFAULT 0,
        sheets_salvo INTEGER DEFAULT 0,
        calendar_salvo INTEGER DEFAULT 0,
        tentativas_reativacao INTEGER DEFAULT 0,
        ultima_reativacao_em TIMESTAMPTZ,
        lembrete_enviado INTEGER DEFAULT 0,
        desistido INTEGER DEFAULT 0,
        sheets_row INTEGER,
        calendar_event_id TEXT,
        transferido_humano_em TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await p.query(`CREATE INDEX IF NOT EXISTS idx_conv_phone_created ON conversations(phone, created_at DESC)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_conv_phone_role ON conversations(phone, role)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_leads_agend ON leads(agendamento_confirmado)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_leads_desistido ON leads(desistido)`);

    console.log('[DB] Schema verificado/criado no PostgreSQL');
  })();
  return schemaPromise;
}

export async function ensureSchema() {
  return initSchema();
}

export async function getUltimaMensagemUserEm(phone) {
  await initSchema();
  const res = await getPool().query(
    `SELECT created_at FROM conversations WHERE phone = $1 AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return res.rows[0]?.created_at ?? null;
}

export async function listLeadsParaReativar() {
  await initSchema();
  const res = await getPool().query(
    `SELECT * FROM leads
     WHERE agendamento_confirmado = 0
       AND desistido = 0
       AND tentativas_reativacao < 2`
  );
  return res.rows;
}

export async function listLeadsParaLembrete() {
  await initSchema();
  const res = await getPool().query(
    `SELECT * FROM leads
     WHERE agendamento_confirmado = 1
       AND lembrete_enviado = 0`
  );
  return res.rows;
}

export async function getHistory(phone, limit = 10) {
  await initSchema();
  const res = await getPool().query(
    `SELECT role, content FROM conversations WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
    [phone, limit]
  );
  return res.rows.reverse();
}

export async function saveMessage(phone, role, content, agent = null) {
  await initSchema();
  await getPool().query(
    `INSERT INTO conversations (phone, role, content, agent) VALUES ($1, $2, $3, $4)`,
    [phone, role, content, agent]
  );
}

export async function getLead(phone) {
  await initSchema();
  const res = await getPool().query(`SELECT * FROM leads WHERE phone = $1`, [phone]);
  return res.rows[0] || null;
}

export async function upsertLead(phone, updates = {}) {
  await initSchema();
  const p = getPool();

  // Garante que o lead existe (cria se ainda não houver)
  await p.query(
    `INSERT INTO leads (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING`,
    [phone]
  );

  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return await getLead(phone);
  }

  // Monta SET dinâmico: "col1 = $2, col2 = $3, ..."
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map((k) => updates[k]);

  await p.query(
    `UPDATE leads SET ${setClause}, updated_at = NOW() WHERE phone = $1`,
    [phone, ...values]
  );

  return await getLead(phone);
}

export async function mergeDados(phone, novosDados = {}) {
  const lead = (await getLead(phone)) || {};
  const dadosAtuais = typeof lead.dados === 'string'
    ? JSON.parse(lead.dados || '{}')
    : (lead.dados || {});
  const dadosMerged = { ...dadosAtuais, ...novosDados };
  await upsertLead(phone, { dados: JSON.stringify(dadosMerged) });
  return dadosMerged;
}
