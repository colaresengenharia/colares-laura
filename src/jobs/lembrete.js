import { sendMessage } from '../integrations/zapi.js';
import {
  listLeadsParaLembrete,
  upsertLead,
  saveMessage,
} from '../db/conversations.js';

// Manda lembrete quando a visita está entre LIMITE_MIN e LIMITE_MAX horas no futuro
const LIMITE_MIN_HORAS = 12;
const LIMITE_MAX_HORAS = 30;

// Converte data BR (DD/MM/YYYY) + hora (HH:MM) para Date no fuso de SP
function parseDataHoraSP(data, hora) {
  if (!data || !hora) return null;
  const m = String(data).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return null;
  let [, dia, mes, ano] = m;
  if (ano.length === 2) ano = '20' + ano;
  const hm = String(hora).match(/(\d{1,2})[:h](\d{0,2})/);
  if (!hm) return null;
  const [, hh, mm] = hm;
  const horaInt = parseInt(hh, 10);
  const minInt = parseInt(mm || '0', 10);
  // ISO com offset SP (-03:00)
  const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}T${String(horaInt).padStart(2, '0')}:${String(minInt).padStart(2, '0')}:00-03:00`;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? null : dt;
}

function mensagemLembrete(nome, dataHora, endereco) {
  const primeiroNome = (nome || '').trim().split(' ')[0] || '';
  const saudacao = primeiroNome ? `Oi, ${primeiroNome}!` : 'Oi!';
  const quando = dataHora.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const enderecoPart = endereco ? ` no endereço ${endereco}` : '';
  return `${saudacao} Passando pra lembrar da nossa visita técnica em ${quando}${enderecoPart}. Tá tudo certo pra amanhã? Se precisar remarcar, me avisa. 😊`;
}

export async function rodarLembrete() {
  const leads = listLeadsParaLembrete();
  let enviados = 0;
  const agora = Date.now();

  for (const lead of leads) {
    try {
      const dados = JSON.parse(lead.dados || '{}');
      const data = dados.data_agendada || dados.data;
      const hora = dados.hora;
      const dt = parseDataHoraSP(data, hora);
      if (!dt) continue;

      const horasAteVisita = (dt.getTime() - agora) / (1000 * 60 * 60);
      if (horasAteVisita < LIMITE_MIN_HORAS || horasAteVisita > LIMITE_MAX_HORAS) continue;

      const endereco = dados.endereco_completo || dados.endereco || '';
      const msg = mensagemLembrete(lead.nome, dt, endereco);
      await sendMessage(lead.phone, msg);
      saveMessage(lead.phone, 'assistant', msg, 'lembrete');
      upsertLead(lead.phone, { lembrete_enviado: 1 });
      enviados++;
      console.log(`[LEMBRETE] enviado para ${lead.phone} (visita em ${horasAteVisita.toFixed(1)}h)`);
    } catch (e) {
      console.error(`[LEMBRETE] erro em ${lead.phone}:`, e.message);
    }
  }

  if (enviados > 0) console.log(`[LEMBRETE] ${enviados} mensagem(ns) enviada(s).`);
}
