import { callClaude } from '../integrations/anthropic.js';
import { appendLead, updateLeadRow } from '../integrations/sheets.js';
import { createEvent, updateEvent, temConflito } from '../integrations/calendar.js';
import { upsertLead } from '../db/conversations.js';
import { alertarAdmin } from '../utils/alerta.js';

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
  const dados = JSON.parse(lead?.dados || '{}');
  const prompt = getPromptGuardiao(dados, phone);

  const messages = [
    { role: 'user', content: 'Processe os dados acima e retorne o JSON conforme instruído.' },
  ];

  const resultado = await callClaude(prompt, messages);
  const ehUpdate = !!(lead?.sheets_row || lead?.calendar_event_id);
  const acao = ehUpdate ? 'ATUALIZAÇÃO' : 'CRIAÇÃO';
  console.log(`[GUARDIÃO] Modo: ${acao}`);

  // --- SHEETS ---
  if (resultado.googleSheets) {
    try {
      const payload = { ...resultado.googleSheets, telefone: phone };
      if (lead?.sheets_row) {
        await updateLeadRow(lead.sheets_row, payload);
        console.log(`[GUARDIÃO] Lead ATUALIZADO no Sheets (linha ${lead.sheets_row}).`);
      } else {
        const rowNumber = await appendLead(payload);
        upsertLead(phone, { sheets_salvo: 1, sheets_row: rowNumber });
        console.log(`[GUARDIÃO] Lead salvo no Sheets (linha ${rowNumber}).`);
      }
    } catch (e) {
      console.error('[GUARDIÃO] Erro no Sheets:', e.message);
      alertarAdmin('sheets', 'Falha ao salvar lead no Google Sheets', `Phone: ${phone}\n${e.message}`).catch(() => {});
    }
  }

  // --- CALENDAR ---
  if (resultado.googleCalendar && lead?.agendamento_confirmado) {
    try {
      // Trava final anti-conflito (race condition: 2 clientes confirmando ao mesmo tempo)
      const check = await temConflito(resultado.googleCalendar.data_inicio, lead?.calendar_event_id || null);
      if (check.conflito) {
        console.error(`[GUARDIÃO] CONFLITO DETECTADO ao criar evento — bloqueador: ${check.eventoBloqueador?.summary} ${check.eventoBloqueador?.inicio}. Evento NÃO criado.`);
        // Não cria o evento. Marca o lead como precisando ser reagendado.
        upsertLead(phone, { agendamento_confirmado: 0, proximo_agente: 'agendador' });
      } else if (lead?.calendar_event_id) {
        await updateEvent(lead.calendar_event_id, resultado.googleCalendar);
        console.log(`[GUARDIÃO] Evento ATUALIZADO no Calendar (${lead.calendar_event_id}):`, resultado.googleCalendar.data_inicio);
      } else {
        const eventCriado = await createEvent(resultado.googleCalendar);
        upsertLead(phone, { calendar_salvo: 1, calendar_event_id: eventCriado.id });
        console.log(`[GUARDIÃO] Evento criado no Calendar (${eventCriado.id}):`, resultado.googleCalendar.data_inicio);
      }
    } catch (e) {
      console.error('[GUARDIÃO] Erro no Calendar:', e.message);
      console.error('[GUARDIÃO] Dados Calendar:', JSON.stringify(resultado.googleCalendar));
      alertarAdmin('calendar', 'Falha ao criar evento no Google Calendar', `Phone: ${phone}\n${e.message}`).catch(() => {});
    }
  } else {
    console.log('[GUARDIÃO] Calendar ignorado. agendamento_confirmado:', lead?.agendamento_confirmado);
  }

  return resultado;
}
