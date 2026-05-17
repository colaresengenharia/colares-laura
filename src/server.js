import 'dotenv/config';
import express from 'express';
import { triador } from './agents/triador.js';
import { recepcao } from './agents/recepcao.js';
import { qualificador } from './agents/qualificador.js';
import { tecnico } from './agents/tecnico.js';
import { agendador } from './agents/agendador.js';
import { guardiao } from './agents/guardiao.js';
import { sendMessage, extractPhone, extractMessage } from './integrations/zapi.js';
import {
  getHistory,
  saveMessage,
  getLead,
  upsertLead,
  mergeDados,
} from './db/conversations.js';
import { ensureHeaders } from './integrations/sheets.js';

const app = express();
app.use(express.json());

const MENSAGEM_ERRO =
  'Desculpe, tive uma instabilidade aqui. Por favor, tente novamente em alguns instantes. 🙏';

const AGENTES = {
  recepcao,
  qualificador,
  tecnico,
  agendador,
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  // Ignora mensagens enviadas pela própria instância
  if (body?.fromMe || body?.isGroup) return;

  const phone = extractPhone(body);
  const mensagem = extractMessage(body);

  if (!phone || !mensagem) return;

  try {
    await processarMensagem(phone, mensagem);
  } catch (err) {
    console.error(`[ERRO] ${phone}:`, err.message);
    await sendMessage(phone, MENSAGEM_ERRO).catch(() => {});
  }
});

async function processarMensagem(phone, mensagem) {
  const historico = getHistory(phone, 10);
  const lead = getLead(phone) ?? upsertLead(phone);

  saveMessage(phone, 'user', mensagem);

  // 1. Triador decide o próximo agente
  const triagem = await triador(mensagem, historico);
  const agentNome = lead?.proximo_agente ?? triagem.proximo_agente ?? 'recepcao';

  if (agentNome === 'encerrar') return;

  // 2. Agente especializado responde
  let resultado;

  if (agentNome === 'guardiao') {
    await guardiao(phone, lead);
    return;
  }

  const agentFn = AGENTES[agentNome];
  if (!agentFn) {
    console.warn(`Agente desconhecido: ${agentNome}`);
    return;
  }

  resultado = await agentFn(mensagem, historico, lead);

  // 3. Salvar dados coletados
  if (resultado.dados_coletados) {
    mergeDados(phone, resultado.dados_coletados);
  }

  if (resultado.lgpd_consentido) {
    upsertLead(phone, { lgpd_consentido: 1 });
  }

  if (resultado.agendamento_confirmado) {
    upsertLead(phone, { agendamento_confirmado: 1 });
  }

  const proximoAgente = resultado.proximo_agente ?? agentNome;
  upsertLead(phone, {
    estagio: triagem.estagio,
    proximo_agente: proximoAgente,
    nome: resultado.dados_coletados?.nome || lead?.nome || '',
  });

  // 4. Se agendamento confirmado, aciona o Guardião em background
  if (resultado.agendamento_confirmado) {
    const leadAtualizado = getLead(phone);
    guardiao(phone, leadAtualizado).catch((e) =>
      console.error('[GUARDIÃO]', e.message)
    );
  }

  // 5. Envia resposta ao cliente
  const resposta = resultado.resposta_cliente;
  if (resposta) {
    await sendMessage(phone, resposta);
    saveMessage(phone, 'assistant', resposta, agentNome);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[Laura] Servidor rodando na porta ${PORT}`);
  try {
    await ensureHeaders();
    console.log('[Sheets] Cabeçalhos verificados.');
  } catch (e) {
    console.warn('[Sheets] Não foi possível verificar cabeçalhos:', e.message);
  }
});
