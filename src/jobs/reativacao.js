import { sendMessage } from '../integrations/zapi.js';
import {
  listLeadsParaReativar,
  getUltimaMensagemUserEm,
  upsertLead,
  saveMessage,
} from '../db/conversations.js';

// Janelas: 48h após última mensagem do cliente (1ª tentativa), 5 dias (2ª tentativa)
const JANELA_HORAS = [48, 5 * 24];

function horasDesde(isoString) {
  if (!isoString) return Infinity;
  const ms = Date.now() - new Date(isoString.replace(' ', 'T') + 'Z').getTime();
  return ms / (1000 * 60 * 60);
}

function mensagemReativacao(tentativa, nome) {
  const primeiroNome = (nome || '').trim().split(' ')[0] || '';
  const saudacao = primeiroNome ? `Oi, ${primeiroNome}!` : 'Oi!';

  if (tentativa === 0) {
    return `${saudacao} Aqui é a Laura, da Colares Engenharia. Conseguiu pensar sobre o que conversamos? Se precisar, estou por aqui. 😊`;
  }
  return `${saudacao} Passando rapidinho pra saber se ainda faz sentido seguirmos com a visita técnica. Se preferir, posso te enviar um material curto sobre como funciona o nosso atendimento.`;
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
