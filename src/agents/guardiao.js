import { callClaude } from '../integrations/anthropic.js';
import { prompts } from '../prompts/system-prompts.js';
import { appendLead } from '../integrations/sheets.js';
import { createEvent } from '../integrations/calendar.js';
import { upsertLead } from '../db/conversations.js';

export async function guardiao(phone, lead) {
  const dados = JSON.parse(lead?.dados || '{}');

  const messages = [
    {
      role: 'user',
      content: `Dados coletados para salvar:\n${JSON.stringify({ ...dados, telefone: phone })}`,
    },
  ];

  const resultado = await callClaude(prompts.guardiao, messages);

  if (resultado.googleSheets) {
    await appendLead({ ...resultado.googleSheets, telefone: phone });
    upsertLead(phone, { sheets_salvo: 1 });
  }

  if (resultado.googleCalendar && lead?.agendamento_confirmado) {
    await createEvent(resultado.googleCalendar);
    upsertLead(phone, { calendar_salvo: 1 });
  }

  return resultado;
}
