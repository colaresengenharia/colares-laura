import 'dotenv/config';
import express from 'express';
import { triador } from './agents/triador.js';
import { recepcao } from './agents/recepcao.js';
import { qualificador } from './agents/qualificador.js';
import { tecnico } from './agents/tecnico.js';
import { agendador } from './agents/agendador.js';
import { pos_agendamento } from './agents/pos_agendamento.js';
import { guardiao } from './agents/guardiao.js';
import { sendMessage, sendAudio, sendChatState, extractPhone, extractMessage, isAudio, downloadAudioBase64 } from './integrations/zapi.js';
import { transcribeAudio } from './integrations/speech.js';
import { sintetizarVoz } from './integrations/tts.js';
import {
  getHistory,
  saveMessage,
  getLead,
  upsertLead,
  mergeDados,
} from './db/conversations.js';
import { ensureHeaders } from './integrations/sheets.js';
import { temConflito, proximosSlotsLivres, deleteEvent } from './integrations/calendar.js';
import { iniciarScheduler } from './jobs/scheduler.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const MENSAGEM_ERRO = 'Desculpe, tive uma instabilidade aqui. Tenta de novo em instantes. 🙏';
const MENSAGEM_AUDIO_FALHOU = 'Recebi seu áudio, mas não consegui ouvi-lo desta vez. Pode me escrever? 😊';

const AGENTES = { recepcao, qualificador, tecnico, agendador, pos_agendamento };

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Monta uma frase natural oferecendo os horários livres ao cliente, sem revelar a agenda.
// Agrupa por dia quando todos os slots são do mesmo dia.
function montarMensagemSlots(slots) {
  if (!slots || slots.length === 0) {
    return 'Esse horário não está disponível e nos próximos dias minha agenda está cheia. Pode me sugerir outra data daqui a uns dias?';
  }

  const fmtHora = (d) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const fmtDia = (d) => {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje.getTime() + 86400_000);
    const dpAmanha = new Date(hoje.getTime() + 2 * 86400_000);
    const meioDia = new Date(d);
    meioDia.setHours(0, 0, 0, 0);

    if (meioDia.getTime() === hoje.getTime()) return 'hoje';
    if (meioDia.getTime() === amanha.getTime()) return 'amanhã';
    if (meioDia.getTime() === dpAmanha.getTime()) return 'depois de amanhã';
    return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' });
  };

  // Se todos os slots forem do mesmo dia, agrupa
  const diasUnicos = new Set(slots.map((s) => {
    const d = new Date(s);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }));

  if (diasUnicos.size === 1) {
    const dia = fmtDia(slots[0]);
    const horas = slots.map(fmtHora).join(', ').replace(/, ([^,]+)$/, ' ou $1');
    return `Esse horário não está disponível. ${dia.charAt(0).toUpperCase() + dia.slice(1)} eu tenho ${horas}. Algum desses funciona pra você?`;
  }

  // Dias diferentes — lista cada um
  const opcoes = slots.map((s) => `${fmtDia(s)} às ${fmtHora(s)}`).join(', ').replace(/, ([^,]+)$/, ' ou $1');
  return `Esse horário não está disponível. Posso te oferecer ${opcoes}. Qual prefere?`;
}

// Converte data BR ("DD/MM/AAAA") + hora ("HH:MM") em string ISO no fuso de São Paulo (-03:00).
// Retorna null se não conseguir interpretar.
function combinarDataHoraSP(data, hora) {
  if (!data || !hora) return null;
  const mData = String(data).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  const mHora = String(hora).match(/(\d{1,2})[:h](\d{2})/);
  if (!mData || !mHora) return null;
  let [, d, m, y] = mData;
  if (y.length === 2) y = '20' + y;
  const [, hh, mm] = mHora;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00-03:00`;
}

// Divide uma resposta longa em 1-3 mensagens curtas, como gente real faz no WhatsApp
function dividirEmMensagens(texto) {
  if (!texto) return [];
  const limpo = texto.trim();

  // Curto demais: 1 mensagem só
  if (limpo.length < 70) return [limpo];

  // Quebra por parágrafos (linhas em branco) primeiro — respeita formatação intencional
  const paragrafos = limpo.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragrafos.length >= 2 && paragrafos.length <= 3) return paragrafos;
  if (paragrafos.length > 3) {
    // Junta paragrafos extras no último
    return [paragrafos[0], paragrafos[1], paragrafos.slice(2).join('\n\n')];
  }

  // 1 parágrafo só: tenta quebrar por frase
  const frases = limpo.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/).map((f) => f.trim()).filter(Boolean);
  if (frases.length === 1) return [limpo];
  if (frases.length === 2) return frases;

  // 3+ frases: agrupa em 2 mensagens balanceadas
  const meio = Math.ceil(frases.length / 2);
  return [frases.slice(0, meio).join(' '), frases.slice(meio).join(' ')];
}

// Calcula quanto tempo "digitar" uma mensagem (delay proporcional ao tamanho)
function calcularDelayDigitacao(texto) {
  // ~30ms por caractere, mínimo 1500ms, máximo 4500ms
  const base = (texto?.length || 0) * 30;
  return Math.min(4500, Math.max(1500, base));
}

// Envia uma resposta da Laura como se fosse uma pessoa digitando:
// - mostra "digitando..."
// - aguarda tempo proporcional ao tamanho
// - se a mensagem for longa, divide em 2-3 partes com pausa entre elas
async function enviarComoHumano(phone, texto) {
  const partes = dividirEmMensagens(texto);
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    await sendChatState(phone, 'composing');
    await sleep(calcularDelayDigitacao(parte));
    await sendMessage(phone, parte);
    // Pausa entre mensagens (700-1300ms aleatório) para parecer natural
    if (i < partes.length - 1) {
      await sleep(700 + Math.floor(Math.random() * 600));
    }
  }
  await sendChatState(phone, 'paused');
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Endpoint temporário de debug — usado pra inspecionar conversas durante testes
// Protegido por token simples na query
app.get('/debug/conversation/:phone', (req, res) => {
  const token = process.env.DEBUG_TOKEN;
  // Se a variável não está setada, bloqueia tudo (endpoint desligado).
  // Se está setada, só passa se o token bater exatamente.
  if (!token || req.query.token !== token) return res.sendStatus(403);
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
      // Flag de ambiente: TTS_ATIVO=true habilita resposta em áudio. Default = desligado.
      const ttsAtivo = String(process.env.TTS_ATIVO || '').toLowerCase() === 'true';
      await processarMensagem(phone, transcricao, body, { responderEmAudio: ttsAtivo });
      return;
    }

    // Mensagem de texto
    const mensagem = extractMessage(body);
    if (!mensagem) return;

    await processarMensagem(phone, mensagem, body, { responderEmAudio: false });
  } catch (err) {
    console.error(`[ERRO] ${phone}:`, err.message);
    await sendMessage(phone, MENSAGEM_ERRO).catch(() => {});
  }
});

async function processarMensagem(phone, mensagem, _body, opts = {}) {
  const responderEmAudio = !!opts.responderEmAudio;
  const historico = getHistory(phone, 10);
  const lead = getLead(phone) ?? upsertLead(phone, {});

  // Salva telefone automaticamente no JSON 'dados' (a tabela leads não tem coluna telefone)
  const dadosAtuais = JSON.parse(lead?.dados || '{}');
  if (!dadosAtuais.telefone) {
    mergeDados(phone, { telefone: phone });
  }

  saveMessage(phone, 'user', mensagem);

  const triagem = await triador(mensagem, historico);

  // Roteamento por estado do lead:
  // - Se JÁ AGENDOU (e não está em reagendamento ativo): vai pro pos_agendamento por padrão.
  //   O triador pode override se identificar caso específico (ex: dúvida técnica).
  // - Senão: usa proximo_agente salvo ou o que o triador decidiu.
  let agentNome;
  if (lead?.agendamento_confirmado) {
    // Triador pode pedir explicitamente pos_agendamento, agendador (reagendar) ou tecnico (dúvida)
    const triadoValido = ['pos_agendamento', 'agendador', 'tecnico'].includes(triagem.proximo_agente)
      ? triagem.proximo_agente
      : 'pos_agendamento';
    agentNome = triadoValido;
  } else {
    const proximoAgenteSalvo = lead?.proximo_agente;
    agentNome = proximoAgenteSalvo ?? triagem.proximo_agente ?? 'recepcao';
  }

  // Guardião nunca atende cliente — só roda em background. Fallback seguro.
  if (agentNome === 'guardiao') agentNome = lead?.agendamento_confirmado ? 'pos_agendamento' : 'recepcao';

  if (agentNome === 'encerrar') return;

  const agentFn = AGENTES[agentNome];
  if (!agentFn) {
    console.warn(`Agente desconhecido: ${agentNome}`);
    return;
  }

  const resultado = await agentFn(mensagem, historico, lead, phone);

  // Cancelamento de visita (vem do pos_agendamento)
  if (resultado.cancelamento_solicitado && lead?.calendar_event_id) {
    try {
      await deleteEvent(lead.calendar_event_id);
      console.log(`[CANCELAMENTO] Evento ${lead.calendar_event_id} deletado do Calendar.`);
    } catch (e) {
      console.error('[CANCELAMENTO] Falhou ao deletar evento:', e.message);
    }
    upsertLead(phone, {
      agendamento_confirmado: 0,
      calendar_event_id: null,
      calendar_salvo: 0,
      desistido: 1, // para não disparar reativações
    });
  }

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
      upsertLead(phone, { nome: nomeFallback }); // também na coluna nome (não só no JSON dados)
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

  // Trava: só confirma agendamento se tem hora EXATA (HH:MM ou H:MM)
  // Evita salvar visita com "de manhã" / "à tarde" sem hora certa
  if (resultado.agendamento_confirmado) {
    const dadosLead = JSON.parse(getLead(phone)?.dados || '{}');
    const dadosDoAgendamento = resultado.dados_agendamento || {};
    const hora = String(dadosDoAgendamento.hora || dadosLead.hora || '');
    const data = String(dadosDoAgendamento.data || dadosLead.data || '');
    const horaValida = /^\d{1,2}:\d{2}$/.test(hora.trim());

    if (!horaValida) {
      console.warn(`[AGENDADOR] Bloqueada confirmacao sem hora exata. hora="${hora}"`);
      resultado.agendamento_confirmado = false;
      resultado.proximo_agente = 'agendador';
    } else {
      // Trava de conflito: verifica no Calendar se o horário está livre (90min + 2h de buffer)
      try {
        const dataISO = combinarDataHoraSP(data, hora);
        if (dataISO) {
          const leadAtual = getLead(phone);
          const ignoreEventId = leadAtual?.calendar_event_id || null; // permite reagendar sem conflitar consigo
          const check = await temConflito(dataISO, ignoreEventId);
          if (check.conflito) {
            console.warn(`[AGENDADOR] Conflito detectado em ${dataISO}. Sugerindo slots livres.`);
            resultado.agendamento_confirmado = false;
            resultado.proximo_agente = 'agendador';
            // Calcula 3 próximos horários realmente livres a partir do dia pedido
            const dataPedida = new Date(dataISO);
            const slots = await proximosSlotsLivres(dataPedida, 3, 14);
            resultado.resposta_cliente = montarMensagemSlots(slots);
          } else {
            upsertLead(phone, { agendamento_confirmado: 1 });
          }
        } else {
          // Não conseguiu interpretar data — confirma mesmo assim (melhor errar pra confirmar que pra bloquear)
          upsertLead(phone, { agendamento_confirmado: 1 });
        }
      } catch (e) {
        console.error('[AGENDADOR] Erro ao checar conflito no Calendar:', e.message);
        // Em caso de erro na API, confirma mesmo assim — melhor confirmar que travar
        upsertLead(phone, { agendamento_confirmado: 1 });
      }
    }
  }

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
    // Se o cliente mandou áudio, responde também em áudio (com fallback pra texto)
    if (responderEmAudio) {
      try {
        await sendChatState(phone, 'recording'); // "gravando áudio..."
        const audioBase64 = await sintetizarVoz(resposta);
        if (audioBase64) {
          await sendAudio(phone, audioBase64);
          await sendChatState(phone, 'paused');
          console.log(`[TTS] Áudio enviado pra ${phone} (${resposta.length} chars)`);
        } else {
          console.warn('[TTS] Síntese retornou vazio, caindo pra texto');
          await enviarComoHumano(phone, resposta);
        }
      } catch (e) {
        console.error('[TTS] Falhou, enviando como texto:', e.message);
        await enviarComoHumano(phone, resposta);
      }
    } else {
      await enviarComoHumano(phone, resposta);
    }
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
