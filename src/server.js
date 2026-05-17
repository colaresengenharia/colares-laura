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
import { iniciarScheduler } from './jobs/scheduler.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const MENSAGEM_ERRO = 'Desculpe, tive uma instabilidade aqui. Tenta de novo em instantes. 🙏';
const MENSAGEM_AUDIO_FALHOU = 'Recebi seu áudio, mas não consegui ouvi-lo desta vez. Pode me escrever? 😊';

const AGENTES = { recepcao, qualificador, tecnico, agendador };

// Backup: tenta extrair nome quando o agente esquece de preencher dados_coletados.nome
function extrairNomeFallback(mensagem) {
  if (!mensagem) return null;
  const padroes = [
    /(?:meu\s+nome\s+(?:é|eh)|me\s+chamo|sou\s+(?:o|a)?|aqui\s+(?:é|eh)\s+(?:o|a)?|pode\s+me\s+chamar\s+de)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç]+)?)/i,
  ];
  for (const re of padroes) {
    const m = mensagem.match(re);
    if (m && m[1]) {
      return m[1].trim().split(/\s+/).slice(0, 2).join(' ');
    }
  }
  return null;
}

// Backup: detecta consentimento LGPD em respostas afirmativas
function consentiuLGPDFallback(mensagem) {
  if (!mensagem) return false;
  const re = /\b(sim|pode|claro|tudo\s+bem|ok|okay|autorizo|combinado|positivo|certo|de\s+acordo)\b/i;
  return re.test(mensagem);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Endpoint temporário de debug — usado pra inspecionar conversas durante testes
// Protegido por token simples na query
app.get('/debug/conversation/:phone', (req, res) => {
  if (req.query.token !== process.env.DEBUG_TOKEN) return res.sendStatus(403);
  const phone = req.params.phone;
  const lead = getLead(phone);
  const historico = getHistory(phone, 50);
  res.json({ lead, historico });
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
  const lead = getLead(phone) ?? upsertLead(phone, {});

  // Salva telefone automaticamente no JSON 'dados' (a tabela leads não tem coluna telefone)
  const dadosAtuais = JSON.parse(lead?.dados || '{}');
  if (!dadosAtuais.telefone) {
    mergeDados(phone, { telefone: phone });
  }

  saveMessage(phone, 'user', mensagem);

  const triagem = await triador(mensagem, historico);

  // Se já agendou, ignora proximo_agente salvo e deixa o triador decidir
  const proximoAgenteSalvo = lead?.agendamento_confirmado ? null : lead?.proximo_agente;
  let agentNome = proximoAgenteSalvo ?? triagem.proximo_agente ?? 'recepcao';

  // Guardião nunca atende cliente — só roda em background. Fallback para recepcao.
  if (agentNome === 'guardiao') agentNome = 'recepcao';

  if (agentNome === 'encerrar') return;

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

  // Backup: se o agente esqueceu de extrair o nome, tenta via regex na mensagem do cliente
  const nomeAtual = JSON.parse(getLead(phone)?.dados || '{}').nome;
  if (!nomeAtual && !resultado.dados_coletados?.nome) {
    const nomeFallback = extrairNomeFallback(mensagem);
    if (nomeFallback) {
      console.log(`[FALLBACK] Nome extraído via regex: ${nomeFallback}`);
      mergeDados(phone, { nome: nomeFallback });
    }
  }

  // Backup LGPD: se o agente acabou de enviar a mensagem de LGPD no histórico
  // e o cliente respondeu afirmativamente, marca como consentido
  if (!lead?.lgpd_consentido && !resultado.lgpd_consentido) {
    const ultimaAssistant = [...historico].reverse().find((m) => m.role === 'assistant');
    const lauraPedolGPD = ultimaAssistant && /registrar\s+seus\s+dados|lgpd|dados\s+de\s+contato/i.test(ultimaAssistant.content);
    if (lauraPedolGPD && consentiuLGPDFallback(mensagem)) {
      console.log('[FALLBACK] LGPD detectado via regex');
      upsertLead(phone, { lgpd_consentido: 1 });
    }
  }

  if (resultado.lgpd_consentido) upsertLead(phone, { lgpd_consentido: 1 });
  if (resultado.agendamento_confirmado) upsertLead(phone, { agendamento_confirmado: 1 });

  // Nunca salvar 'guardiao' como proximo_agente — quebra próximas mensagens do cliente
  const proximoAgenteParaSalvar =
    resultado.proximo_agente === 'guardiao' ? null : (resultado.proximo_agente ?? agentNome);

  upsertLead(phone, {
    estagio: triagem.estagio,
    proximo_agente: proximoAgenteParaSalvar,
    nome: resultado.dados_coletados?.nome || lead?.nome || '',
  });

  // Dispara guardião sempre que houver confirmação. Ele decide:
  // - se ainda não foi salvo: cria linha + evento (e guarda os IDs)
  // - se já existe: atualiza a mesma linha e o mesmo evento
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
  iniciarScheduler();
});
