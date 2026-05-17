import { sendMessage } from '../integrations/zapi.js';
import {
  listLeadsParaReativar,
  getUltimaMensagemUserEm,
  upsertLead,
  saveMessage,
} from '../db/conversations.js';

// Janelas (em horas) após a última mensagem do cliente:
// 1ª: 15 min (cutucada rápida, leve)
// 2ª: 48h (lembrete do dia seguinte)
// 3ª: 5 dias (última tentativa)
const JANELA_HORAS = [0.25, 48, 5 * 24];

function horasDesde(isoString) {
  if (!isoString) return Infinity;
  const ms = Date.now() - new Date(isoString.replace(' ', 'T') + 'Z').getTime();
  return ms / (1000 * 60 * 60);
}

function mensagemReativacao(tentativa, nome) {
  const primeiroNome = (nome || '').trim().split(' ')[0] || '';

  // 15 min: super leve, pergunta direta. Sem se identificar de novo.
  if (tentativa === 0) {
    const variantes = primeiroNome
      ? [`Tá aí, ${primeiroNome}?`, `${primeiroNome}, conseguiu ver minha mensagem?`, `Oi, ${primeiroNome}, tudo bem?`]
      : [`Tá por aí?`, `Conseguiu ver minha mensagem?`, `Oi, tudo bem?`];
    return variantes[Math.floor(Math.random() * variantes.length)];
  }

  // 48h: lembrete amigável
  if (tentativa === 1) {
    const saudacao = primeiroNome ? `Oi, ${primeiroNome}!` : 'Oi!';
    return `${saudacao} Conseguiu pensar sobre o que a gente conversou? Posso te ajudar com mais alguma dúvida?`;
  }

  // 5 dias: última, mais formal
  const saudacao = primeiroNome ? `Oi, ${primeiroNome}!` : 'Oi!';
  return `${saudacao} Passando só pra saber se ainda faz sentido seguirmos com a visita. Se preferir, fico à disposição quando precisar. 🙏`;
}

export async function rodarReativacao() {
  const leads = listLeadsParaReativar();
  let enviados = 0;

  for (const lead of leads) {
    try {
      const tentativaIdx = lead.tentativas_reativacao || 0;
      const janela = JANELA_HORAS[tentativaIdx];
      if (janela == null) continue;

      // Referência: última mensagem do cliente (ou criação do lead, se nunca falou)
      const ref = getUltimaMensagemUserEm(lead.phone) || lead.created_at;
      const horas = horasDesde(ref);

      if (horas < janela) continue;

      // Se já mandou reativação recente (< janela atual), evita reenvio em janelas curtas de cron
      if (lead.ultima_reativacao_em) {
        const desdeUltima = horasDesde(lead.ultima_reativacao_em);
        if (desdeUltima < janela) continue;
      }

      const msg = mensagemReativacao(tentativaIdx, lead.nome);
      await sendMessage(lead.phone, msg);
      saveMessage(lead.phone, 'assistant', msg, 'reativacao');

      const novaTentativa = tentativaIdx + 1;
      upsertLead(lead.phone, {
        tentativas_reativacao: novaTentativa,
        ultima_reativacao_em: new Date().toISOString().replace('T', ' ').slice(0, 19),
        desistido: novaTentativa >= JANELA_HORAS.length ? 1 : 0,
      });

      enviados++;
      console.log(`[REATIVACAO] ${lead.phone} tentativa ${novaTentativa}/${JANELA_HORAS.length}`);
    } catch (e) {
      console.error(`[REATIVACAO] erro em ${lead.phone}:`, e.message);
    }
  }

  if (enviados > 0) console.log(`[REATIVACAO] ${enviados} mensagem(ns) enviada(s).`);
}
