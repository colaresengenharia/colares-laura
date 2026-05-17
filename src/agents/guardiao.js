import { callClaude } from '../integrations/anthropic.js';
import { appendLead } from '../integrations/sheets.js';
import { createEvent } from '../integrations/calendar.js';
import { upsertLead } from '../db/conversations.js';

function getPromptGuardiao(dados, phone) {
  const agora = new Date();
  const dataAtual = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const horaAtual = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  return `Você é o GUARDIÃO do sistema. NÃO conversa com o cliente.
Receba os dados coletados e produza dois objetos JSON:
um para o Google Sheets (linha do CRM) e outro para o Google Calendar (evento de visita).

DADOS COLETADOS:
${JSON.stringify({ ...dados, telefone: phone }, null, 2)}

INFORMAÇÕES DE TEMPO (use para calcular datas):
- Data atual: ${dataAtual}
- Hora atual: ${horaAtual}
- Fuso: America/Sao_Paulo (GMT-3)
- Se a data do agendamento for "amanhã", calcule a partir da data atual acima.
- data_inicio DEVE estar no formato ISO 8601 exato: "YYYY-MM-DDTHH:MM:00"
  Exemplo correto para hoje às 14h: "${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}T14:00:00"

Retorne APENAS JSON válido:
{
  "googleSheets": {
    "data_contato": "${dataAtual} ${horaAtual}",
    "nome": "",
    "telefone": "",
    "cidade": "",
    "bairro": "",
    "tipo_imovel": "",
    "servico": "",
    "descricao": "",
    "urgencia": "",
    "status_lead": "",
    "tipo_agendamento": "presencial",
    "data_agendada": "",
    "hora": "",
    "endereco": "",
    "observacoes": ""
  },
  "googleCalendar": {
    "titulo": "",
    "data_inicio": "",
    "local": "",
    "descricao": ""
  }
}`;
}

export async function guardiao(phone, lead) {
  // Trava de idempotência: se já salvou Sheets E Calendar, não roda de novo
  if (lead?.sheets_salvo && lead?.calendar_salvo) {
    console.log('[GUARDIÃO] Já processado anteriormente, ignorando.');
    return;
  }

  const dados = JSON.parse(lead?.dados || '{}');
  const prompt = getPromptGuardiao(dados, phone);

  const messages = [
    { role: 'user', content: 'Processe os dados acima e retorne o JSON conforme instruído.' },
  ];

  const resultado = await callClaude(prompt, messages);

  if (resultado.googleSheets) {
    try {
      await appendLead({ ...resultado.googleSheets, telefone: phone });
      upsertLead(phone, { sheets_salvo: 1 });
      console.log('[GUARDIÃO] Lead salvo no Sheets.');
    } catch (e) {
      console.error('[GUARDIÃO] Erro no Sheets:', e.message);
    }
  }

  if (resultado.googleCalendar && lead?.agendamento_confirmado) {
    try {
      await createEvent(resultado.googleCalendar);
      upsertLead(phone, { calendar_salvo: 1 });
      console.log('[GUARDIÃO] Evento criado no Calendar:', resultado.googleCalendar.data_inicio);
    } catch (e) {
      console.error('[GUARDIÃO] Erro ao criar evento no Calendar:', e.message);
      console.error('[GUARDIÃO] Dados Calendar:', JSON.stringify(resultado.googleCalendar));
    }
  } else {
    console.log('[GUARDIÃO] Calendar ignorado. agendamento_confirmado:', lead?.agendamento_confirmado);
  }

  return resultado;
}
