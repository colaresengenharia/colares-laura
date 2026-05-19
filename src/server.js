import 'dotenv/config';
import express from 'express';
import { triador } from './agents/triador.js';
import { recepcao } from './agents/recepcao.js';
import { qualificador } from './agents/qualificador.js';
import { tecnico } from './agents/tecnico.js';
import { agendador } from './agents/agendador.js';
import { pos_agendamento } from './agents/pos_agendamento.js';
import { guardiao } from './agents/guardiao.js';
import {
  sendMessage, sendAudio, sendChatState,
  extractPhone, extractMessage,
  isAudio, downloadAudioBase64,
  isImage, downloadImageBase64, getImageMimeType, getImageCaption,
  isDocument, downloadDocumentBase64, getDocumentCaption,
} from './integrations/zapi.js';
import { transcribeAudio } from './integrations/speech.js';
import { sintetizarVoz } from './integrations/tts.js';
import { descreverImagem, descreverDocumento } from './integrations/anthropic.js';
import {
  getHistory,
  saveMessage,
  getLead,
  upsertLead,
  mergeDados,
  ensureSchema,
} from './db/conversations.js';
import { ensureHeaders } from './integrations/sheets.js';
import { temConflito, proximosSlotsLivres, deleteEvent, listEventsBetween, DURACAO_VISITA_MIN, BUFFER_ENTRE_VISITAS_MIN } from './integrations/calendar.js';
import { iniciarScheduler } from './jobs/scheduler.js';
import { alertarAdmin, alertarBoot, notificarAdmin } from './utils/alerta.js';
import { extrairNomeFallback as extrairNomeUtil } from './utils/extracao.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const MENSAGEM_ERRO = 'Desculpe, tive uma instabilidade aqui. Tenta de novo em instantes. 🙏';
const MENSAGEM_AUDIO_FALHOU = 'Recebi seu áudio, mas não consegui ouvi-lo desta vez. Pode me escrever? 😊';

const AGENTES = { recepcao, qualificador, tecnico, agendador, pos_agendamento };

// Reusa a versão compartilhada (mantém compatibilidade com chamadas locais antigas)
const extrairNomeFallback = extrairNomeUtil;

// Backup: detecta consentimento LGPD em respostas afirmativas
function consentiuLGPDFallback(mensagem) {
  if (!mensagem) return false;
  const re = /\b(sim|pode|claro|tudo\s+bem|ok|okay|autorizo|combinado|positivo|certo|de\s+acordo)\b/i;
  return re.test(mensagem);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- TRANSFERÊNCIA HUMANO ---
const TRANSFERENCIA_MIN_PAUSA = 30; // minutos que a Laura fica em pausa após pedido

// Detecta se o cliente está pedindo atendente humano
function pediuHumano(mensagem) {
  if (!mensagem) return false;
  return /\b(falar\s+com\s+(?:um\s+)?(?:humano|pessoa|atendente|engenheiro|alguém|alguem|ser\s+humano|gente|fábio|fabio|responsável|responsavel|funcionário|funcionario)|atendente\s+humano|quero\s+(?:um\s+)?atendente|n[ãa]o\s+quero\s+(?:falar\s+com\s+)?(?:rob[ôo]|bot|m[áa]quina)|tem\s+(?:um\s+)?humano|tem\s+(?:uma\s+)?pessoa|me\s+passa\s+pra?\s+(?:um|uma|alguém|alguem)|fala\s+(?:com\s+)?(?:um\s+)?humano|chamar?\s+(?:um\s+)?atendente|chama\s+(?:o\s+)?engenheiro|preciso\s+(?:falar\s+)?com\s+(?:um\s+)?(?:humano|atendente|pessoa)|n[ãa]o\s+é\s+(?:um\s+)?rob[ôo]|cê\s+é\s+rob[ôo])\b/i.test(mensagem);
}

// Calcula minutos desde um timestamp. Aceita Date object (retornado pelo pg) ou string ISO/SQLite.
function minutosDesde(valor) {
  if (!valor) return Infinity;
  let d;
  if (valor instanceof Date) {
    d = valor;
  } else if (typeof valor === 'string') {
    // Aceita "YYYY-MM-DD HH:MM:SS" (SQLite legacy) ou ISO completo
    d = new Date(valor.includes('T') ? valor : valor.replace(' ', 'T') + 'Z');
  } else {
    d = new Date(valor);
  }
  return (Date.now() - d.getTime()) / 60_000;
}

// Marca o lead como transferido e notifica admin
async function transferirParaHumano(phone, lead, mensagemOriginal) {
  const nome = lead?.nome || JSON.parse(lead?.dados || '{}').nome || '';
  const primeiroNome = (nome || '').split(/\s+/)[0];
  const saudacao = primeiroNome ? `Combinado, ${primeiroNome}!` : 'Combinado!';
  const resposta = `${saudacao} Vou chamar a equipe agora. Em instantes alguém te responde por aqui. 🙏`;

  await upsertLead(phone, { transferido_humano_em: new Date() });

  await enviarComoHumano(phone, resposta);
  await saveMessage(phone, 'assistant', resposta, 'transferencia');

  await notificarAdmin(
    `🔔 *Cliente pedindo atendente*`,
    `Nome: ${nome || '(sem nome)'}\nTelefone: ${phone}\n\nÚltima mensagem:\n"${mensagemOriginal.slice(0, 300)}"\n\nResponda direto pelo WhatsApp.\nLaura fica em pausa por ${TRANSFERENCIA_MIN_PAUSA} min.`
  );
}

// Fila por telefone: garante que mensagens do mesmo cliente sejam processadas em ordem,
// uma de cada vez. Resolve race condition quando o cliente manda 2-3 mensagens consecutivas.
const filasPorTelefone = new Map();
async function enfileirar(phone, fn) {
  const anterior = filasPorTelefone.get(phone) || Promise.resolve();
  const nova = anterior
    .then(() => fn())
    .catch((e) => console.error(`[FILA ${phone}] erro:`, e.message));
  filasPorTelefone.set(phone, nova);
  // Libera memória depois que a fila zerar
  nova.finally(() => {
    if (filasPorTelefone.get(phone) === nova) filasPorTelefone.delete(phone);
  });
  return nova;
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

// Envia a resposta da Laura. Como o WhatsApp não suporta "digitando..." via API,
// removemos os delays artificiais — só mantém uma pausa CURTA entre mensagens divididas
// (pra cliente conseguir ler a primeira parte antes da segunda chegar).
async function enviarComoHumano(phone, texto) {
  const partes = dividirEmMensagens(texto);
  for (let i = 0; i < partes.length; i++) {
    await sendMessage(phone, partes[i]);
    // Pausa curtinha (300-500ms) entre mensagens — só pra não chegarem coladas
    if (i < partes.length - 1) {
      await sleep(300 + Math.floor(Math.random() * 200));
    }
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Endpoint de debug pra verificar manualmente se uma data tem conflito.
// Uso: /debug/check-conflito?token=...&data=2026-05-20T15:30:00-03:00
app.get('/debug/check-conflito', async (req, res) => {
  const token = process.env.DEBUG_TOKEN;
  if (!token || req.query.token !== token) return res.sendStatus(403);
  const data = req.query.data;
  if (!data) return res.status(400).json({ error: 'missing ?data=...' });
  try {
    const novoInicio = new Date(data);
    if (isNaN(novoInicio.getTime())) return res.status(400).json({ error: 'data invalida' });
    const novoFim = new Date(novoInicio.getTime() + DURACAO_VISITA_MIN * 60_000);
    const janelaInicio = new Date(novoInicio.getTime() - 24 * 60 * 60_000);
    const janelaFim = new Date(novoFim.getTime() + 24 * 60 * 60_000);

    const eventos = await listEventsBetween(janelaInicio, janelaFim);
    const resultado = await temConflito(data);

    res.json({
      pedido: {
        data: data,
        inicio_calculado: novoInicio.toISOString(),
        fim_calculado: novoFim.toISOString(),
        duracao_min: DURACAO_VISITA_MIN,
        buffer_min: BUFFER_ENTRE_VISITAS_MIN,
      },
      janela_busca: {
        de: janelaInicio.toISOString(),
        ate: janelaFim.toISOString(),
      },
      eventos_no_calendar: eventos.length,
      eventos: eventos.map((e) => ({
        id: e.id,
        summary: e.summary,
        location: e.location,
        start: e.start,
        end: e.end,
      })),
      resultado_checagem_conflito: resultado,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: (e.stack || '').slice(0, 600) });
  }
});

// Endpoint temporário de debug — usado pra inspecionar conversas durante testes
// Protegido por token simples na query
app.get('/debug/conversation/:phone', async (req, res) => {
  const token = process.env.DEBUG_TOKEN;
  // Se a variável não está setada, bloqueia tudo (endpoint desligado).
  // Se está setada, só passa se o token bater exatamente.
  if (!token || req.query.token !== token) return res.sendStatus(403);
  try {
    const phone = req.params.phone;
    const lead = await getLead(phone);
    const historico = await getHistory(phone, 50);
    res.json({ lead, historico });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      await enfileirar(phone, () => processarMensagem(phone, transcricao, body, { responderEmAudio: ttsAtivo }));
      return;
    }

    // Mensagem de imagem (foto do problema, do imóvel, etc)
    if (isImage(body)) {
      console.log(`[IMAGE] Recebida de ${phone}`);
      const base64 = await downloadImageBase64(body);
      if (!base64) {
        await enfileirar(phone, () => processarMensagem(phone, 'Recebi sua foto mas não consegui abrir. Pode me descrever o que aparece?', body));
        return;
      }
      const descricao = await descreverImagem(base64, getImageMimeType(body));
      const caption = getImageCaption(body);
      if (!descricao) {
        await enfileirar(phone, () => processarMensagem(phone, `Recebi sua foto. ${caption ? `Legenda: ${caption}` : ''}`, body));
        return;
      }
      console.log(`[IMAGE] Descrição: ${descricao.slice(0, 80)}`);
      // Compõe um texto que o agente vai entender como "cliente mandou foto + o que aparece"
      const textoComposto = caption
        ? `[O cliente enviou uma foto COM esta legenda: "${caption}"]\n\nDescrição técnica do que aparece na imagem:\n${descricao}\n\nINSTRUÇÃO: responda comentando o que viu na foto E o que ele disse na legenda. Demonstre que você "olhou" a imagem.`
        : `[O cliente enviou uma foto SEM nenhuma mensagem escrita junto.]\n\nDescrição técnica do que aparece na imagem:\n${descricao}\n\nINSTRUÇÃO: responda comentando especificamente o que você viu na foto (mostre que olhou). Se identificou problema técnico, mencione isso de forma simples e ofereça a visita. Se a foto for ambígua, pergunte gentilmente o que ele gostaria de saber sobre o que mostrou.`;
      await enfileirar(phone, () => processarMensagem(phone, textoComposto, body));
      return;
    }

    // Mensagem de documento (PDF, laudo, planta, etc)
    if (isDocument(body)) {
      console.log(`[DOC] Recebido de ${phone}`);
      const base64 = await downloadDocumentBase64(body);
      if (!base64) {
        await enfileirar(phone, () => processarMensagem(phone, 'Recebi seu documento mas não consegui abrir. Pode me contar o que é?', body));
        return;
      }
      const resumo = await descreverDocumento(base64);
      const caption = getDocumentCaption(body);
      if (!resumo) {
        await enfileirar(phone, () => processarMensagem(phone, `Recebi seu documento (${caption || 'PDF'}).`, body));
        return;
      }
      console.log(`[DOC] Resumo: ${resumo.slice(0, 80)}`);
      const textoComposto = `[O cliente enviou um documento PDF. Resumo do conteúdo: ${resumo}]${caption ? `\nNome do arquivo / legenda: "${caption}"` : ''}`;
      await enfileirar(phone, () => processarMensagem(phone, textoComposto, body));
      return;
    }

    // Mensagem de texto
    const mensagem = extractMessage(body);
    if (!mensagem) return;

    await enfileirar(phone, () => processarMensagem(phone, mensagem, body, { responderEmAudio: false }));
  } catch (err) {
    console.error(`[ERRO] ${phone}:`, err.message);
    await sendMessage(phone, MENSAGEM_ERRO).catch(() => {});
    // Alerta o admin (com throttle de 1h pra não spammar)
    alertarAdmin('webhook', 'Erro ao processar mensagem', `Phone: ${phone}\nErro: ${err.message}\nStack: ${(err.stack || '').slice(0, 300)}`).catch(() => {});
  }
});

// Erros não capturados — só LOGA, não mata o processo (process.exit(1) gerava loop de crash).
// O alerta é disparado em "background" sem await pra não bloquear.
process.on('uncaughtException', (err) => {
  console.error('[ERRO-NAO-CAPTURADO]', err);
  alertarAdmin('crash', 'Erro não capturado no servidor', err.message + '\n' + (err.stack || '').slice(0, 400)).catch(() => {});
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROMISE-NAO-TRATADA]', reason);
  alertarAdmin('crash', 'Promise não tratada', String(reason).slice(0, 400)).catch(() => {});
});

async function processarMensagem(phone, mensagem, _body, opts = {}) {
  const responderEmAudio = !!opts.responderEmAudio;
  const historico = await getHistory(phone, 10);
  const lead = (await getLead(phone)) ?? (await upsertLead(phone, {}));

  // Salva telefone automaticamente no JSON 'dados' (a tabela leads não tem coluna telefone)
  const dadosAtuais = JSON.parse(lead?.dados || '{}');
  if (!dadosAtuais.telefone) {
    await mergeDados(phone, { telefone: phone });
  }

  await saveMessage(phone, 'user', mensagem);

  // --- TRANSFERÊNCIA HUMANO ---
  // 1) Se o lead JÁ está em transferência ativa: bot fica em pausa, só notifica admin
  if (lead?.transferido_humano_em) {
    const minDesde = minutosDesde(lead.transferido_humano_em);
    if (minDesde < TRANSFERENCIA_MIN_PAUSA) {
      // Continua em pausa — não responde, mas avisa o admin de cada nova mensagem
      const nome = lead.nome || dadosAtuais.nome || '';
      await notificarAdmin(
        `📩 *Nova mensagem em transferência*`,
        `${nome ? nome + ' (' + phone + ')' : phone}:\n"${mensagem.slice(0, 300)}"\n\n_Faltam ${Math.ceil(TRANSFERENCIA_MIN_PAUSA - minDesde)} min pra Laura voltar automaticamente._`
      );
      console.log(`[TRANSFER] Cliente ${phone} em pausa (${Math.round(minDesde)}/${TRANSFERENCIA_MIN_PAUSA} min). Bot não respondeu.`);
      return;
    }
    // 30+ min sem você responder: limpa o flag e a Laura volta a atender
    await upsertLead(phone, { transferido_humano_em: null });
    await notificarAdmin(
      `🔄 *Bot reativado*`,
      `${lead.nome || phone}: passaram ${TRANSFERENCIA_MIN_PAUSA} min sem resposta sua. Laura voltou a atender automaticamente.`
    );
  }

  // 2) Cliente está pedindo humano AGORA?
  if (pediuHumano(mensagem)) {
    await transferirParaHumano(phone, lead, mensagem);
    return;
  }

  const triagem = await triador(mensagem, historico);

  // Roteamento por estado do lead:
  // - Se JÁ AGENDOU: vai pro pos_agendamento por padrão.
  // - Se é PRIMEIRA mensagem do cliente (lead sem nome ainda): SEMPRE recepção (pra coletar nome).
  // - Senão: usa proximo_agente salvo ou o que o triador decidiu.
  let agentNome;
  const dadosLead = JSON.parse(lead?.dados || '{}');
  const temNome = !!(dadosLead.nome || lead?.nome);
  const ehPrimeiraInteracao = historico.filter((m) => m.role === 'assistant').length === 0;

  if (lead?.agendamento_confirmado) {
    const triadoValido = ['pos_agendamento', 'agendador', 'tecnico'].includes(triagem.proximo_agente)
      ? triagem.proximo_agente
      : 'pos_agendamento';
    agentNome = triadoValido;
  } else if (ehPrimeiraInteracao && !temNome) {
    // Força recepção pra garantir coleta do nome antes de qualquer outra coisa.
    agentNome = 'recepcao';
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

  // Backup: detecta intenção de cancelamento mesmo se o agente esqueceu o flag.
  // Acontece quando cliente diz claramente "cancelar/desmarcar" E a Laura confirma o cancelamento na resposta.
  // Importante: \b no FINAL do regex falha em "cancelada"/"cancelado" porque depois vem letra.
  // Usamos prefixo "cancelad" sem \b final pra casar "cancelado/a/os/as".
  if (!resultado.cancelamento_solicitado && lead?.agendamento_confirmado) {
    const clienteQuerCancelar = /\b(cancelar|cancela|desmarcar|desmarca|desistir|desisto|n[ãa]o\s+vou\s+mais|tira\s+da\s+agenda)\b/i.test(mensagem);
    const lauraConfirmouCancelamento = resultado.resposta_cliente && /(\bcancelad|\bcancelei|cancelo aqui|tirei da agenda|visita cancelad)/i.test(resultado.resposta_cliente);
    if (clienteQuerCancelar && lauraConfirmouCancelamento) {
      console.log('[FALLBACK] Cancelamento detectado por regex (agente esqueceu o flag).');
      resultado.cancelamento_solicitado = true;
      resultado.proximo_agente = 'encerrar';
    }
  }

  // Cancelamento de visita (vem do pos_agendamento)
  if (resultado.cancelamento_solicitado && lead?.calendar_event_id) {
    try {
      await deleteEvent(lead.calendar_event_id);
      console.log(`[CANCELAMENTO] Evento ${lead.calendar_event_id} deletado do Calendar.`);
    } catch (e) {
      console.error('[CANCELAMENTO] Falhou ao deletar evento:', e.message);
    }
    await upsertLead(phone, {
      agendamento_confirmado: 0,
      calendar_event_id: null,
      calendar_salvo: 0,
      desistido: 1, // para não disparar reativações
    });
  }

  if (resultado.dados_coletados) {
    await mergeDados(phone, resultado.dados_coletados);
  }

  // Salva dados do agendamento (endereço, data, hora) para o Guardião usar
  if (resultado.dados_agendamento) {
    await mergeDados(phone, resultado.dados_agendamento);
  }

  // Backup: se o agente esqueceu de extrair o nome, tenta via regex na mensagem do cliente
  const leadAposMerge = await getLead(phone);
  const nomeAtual = JSON.parse(leadAposMerge?.dados || '{}').nome;
  if (!nomeAtual && !resultado.dados_coletados?.nome) {
    const nomeFallback = extrairNomeFallback(mensagem);
    if (nomeFallback) {
      console.log(`[FALLBACK] Nome extraído via regex: ${nomeFallback}`);
      await mergeDados(phone, { nome: nomeFallback });
      await upsertLead(phone, { nome: nomeFallback }); // também na coluna nome (não só no JSON dados)
    }
  }

  // Backup LGPD: se o agente acabou de enviar a mensagem de LGPD no histórico
  // e o cliente respondeu afirmativamente, marca como consentido
  if (!lead?.lgpd_consentido && !resultado.lgpd_consentido) {
    const ultimaAssistant = [...historico].reverse().find((m) => m.role === 'assistant');
    const lauraPedolGPD = ultimaAssistant && /registrar\s+seus\s+dados|lgpd|dados\s+de\s+contato/i.test(ultimaAssistant.content);
    if (lauraPedolGPD && consentiuLGPDFallback(mensagem)) {
      console.log('[FALLBACK] LGPD detectado via regex');
      await upsertLead(phone, { lgpd_consentido: 1 });
    }
  }

  if (resultado.lgpd_consentido) await upsertLead(phone, { lgpd_consentido: 1 });

  // Trava: só confirma agendamento se tem hora EXATA (HH:MM ou H:MM)
  // Evita salvar visita com "de manhã" / "à tarde" sem hora certa
  if (resultado.agendamento_confirmado) {
    const leadParaAgend = await getLead(phone);
    const dadosLead = JSON.parse(leadParaAgend?.dados || '{}');
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
          const ignoreEventId = leadParaAgend?.calendar_event_id || null; // permite reagendar sem conflitar consigo
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
            await upsertLead(phone, { agendamento_confirmado: 1 });
          }
        } else {
          // Não conseguiu interpretar data — confirma mesmo assim (melhor errar pra confirmar que pra bloquear)
          await upsertLead(phone, { agendamento_confirmado: 1 });
        }
      } catch (e) {
        console.error('[AGENDADOR] Erro ao checar conflito no Calendar:', e.message);
        // Em caso de erro na API, confirma mesmo assim — melhor confirmar que travar
        await upsertLead(phone, { agendamento_confirmado: 1 });
      }
    }
  }

  // Nunca salvar 'guardiao' como proximo_agente — quebra próximas mensagens do cliente
  const proximoAgenteParaSalvar =
    resultado.proximo_agente === 'guardiao' ? null : (resultado.proximo_agente ?? agentNome);

  await upsertLead(phone, {
    estagio: triagem.estagio,
    proximo_agente: proximoAgenteParaSalvar,
    nome: resultado.dados_coletados?.nome || lead?.nome || '',
  });

  // Dispara guardião sempre que houver confirmação. Ele decide:
  // - se ainda não foi salvo: cria linha + evento (e guarda os IDs)
  // - se já existe: atualiza a mesma linha e o mesmo evento
  if (resultado.agendamento_confirmado) {
    const leadAtualizado = await getLead(phone);
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
    await saveMessage(phone, 'assistant', resposta, agentNome);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[Laura] Servidor rodando na porta ${PORT}`);

  // Garante que o schema do PostgreSQL existe antes de processar qualquer mensagem
  try {
    await ensureSchema();
  } catch (e) {
    console.error('[DB] Falha ao inicializar schema:', e.message);
    alertarAdmin('db-boot', 'Falha ao conectar/criar schema do PostgreSQL', e.message).catch(() => {});
  }

  try {
    await ensureHeaders();
    console.log('[Sheets] Cabeçalhos verificados.');
  } catch (e) {
    console.warn('[Sheets] Não foi possível verificar cabeçalhos:', e.message);
    alertarAdmin('sheets-boot', 'Sheets indisponível ao iniciar', e.message).catch(() => {});
  }
  iniciarScheduler();
  alertarBoot().catch(() => {}); // notifica que o servidor subiu
});
