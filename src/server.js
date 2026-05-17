import 'dotenv/config';
import express from 'express';
import { triador } from './agents/triador.js';
import { recepcao } from './agents/recepcao.js';
import { qualificador } from './agents/qualificador.js';
import { tecnico } from './agents/tecnico.js';
import { agendador } from './agents/agendador.js';
import { guardiao } from './agents/guardiao.js';
import { sendMessage, extractPhone, extractMessage, isAudio, downloadAudioBase64 } from './integrations/zapi.js';
import { transcribeAudio } from './integrations/speech.js';
import {
  getHistory,
  saveMessage,
  getLead,
  upsertLead,
  mergeDados,
} from './db/conversations.js';
import { ensureHeaders } from './integrations/sheets.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const MENSAGEM_ERRO = 'Desculpe, tive uma instabilidade aqui. Tenta de novo em instantes. 🙏';
const MENSAGEM_AUDIO_FALHOU = 'Recebi seu áudio, mas não consegui ouvi-lo desta vez. Pode me escrever? 😊';

const AGENTES = { recepcao, qualificador, tecnico, agendador };

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body?.fromMe || body?.isGroup) return;

  const phone = extractPhone(body);
  if (!phone) return;

  try {
    // Log de todos os webhooks para diagnóstico
    console.log(`[WEBHOOK] phone=${phone} type=${body?.type} hasAudio=${JSON.stringify(body?.audio)?.slice(0, 80)}`);

    // Mensagem de áudio
    if (isAudio(body)) {
      console.log(`[AUDIO] Recebido de ${phone}`);
      const base64 = await downloadAudioBase64(body);
      if (!base64) {
        await sendMessage(phone, MENSAGEM_AUDIO_FALHOU);
        return;
      }
      const transcricao = await transcribeAudio(base64);
      if (!transcricao) {
        await sendMessage(phone, MENSAGEM_AUDIO_FALHOU);
        return;
      }
      console.log(`[AUDIO] Transcrito: ${transcricao.slice(0, 80)}`);
      await processarMensagem(phone, transcricao, body);
      return;
    }

    // Mensagem de texto
    const mensagem = extractMessage(body);
    if (!mensagem) return;

    await processarMensagem(phone, mensagem, body);
  } catch (err) {
    console.error(`[ERRO] ${phone}:`, err.message);
    await sendMessage(phone, MENSAGEM_ERRO).catch(() => {});
  }
});

async function processarMensagem(phone, mensagem) {
  const historico = getHistory(phone, 10);
  const lead = getLead(phone) ?? upsertLead(phone, { telefone: phone });

  // Salva telefone automaticamente do WhatsApp
  const dadosAtuais = JSON.parse(lead?.dados || '{}');
  if (!dadosAtuais.telefone) {
    mergeDados(phone, { telefone: phone });
  }

  saveMessage(phone, 'user', mensagem);

  const triagem = await triador(mensagem, historico);
  const agentNome = lead?.proximo_agente ?? triagem.proximo_agente ?? 'recepcao';

  if (agentNome === 'encerrar') return;

  if (agentNome === 'guardiao') {
    await guardiao(phone, lead);
    return;
  }

  const agentFn = AGENTES[agentNome];
  if (!agentFn) {
    console.warn(`Agente desconhecido: ${agentNome}`);
    return;
  }

  const resultado = await agentFn(mensagem, historico, lead, phone);

  if (resultado.dados_coletados) {
    mergeDados(phone, resultado.dados_coletados);
  }

  // Salva dados do agendamento (endereço, data, hora) para o Guardião usar
  if (resultado.dados_agendamento) {
    mergeDados(phone, resultado.dados_agendamento);
  }

  if (resultado.lgpd_consentido) upsertLead(phone, { lgpd_consentido: 1 });
  if (resultado.agendamento_confirmado) upsertLead(phone, { agendamento_confirmado: 1 });

  upsertLead(phone, {
    estagio: triagem.estagio,
    proximo_agente: resultado.proximo_agente ?? agentNome,
    nome: resultado.dados_coletados?.nome || lead?.nome || '',
  });

  if (resultado.agendamento_confirmado) {
    const leadAtualizado = getLead(phone);
    guardiao(phone, leadAtualizado).catch((e) => console.error('[GUARDIÃO]', e.message));
  }

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
