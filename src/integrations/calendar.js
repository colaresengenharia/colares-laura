import { google } from 'googleapis';

function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

function parseDataInicio(valor) {
  if (!valor) throw new Error('data_inicio ausente');

  // Já está em formato ISO ou reconhecível
  const tentativa = new Date(valor);
  if (!isNaN(tentativa.getTime())) return tentativa;

  // Tenta extrair data e hora de strings em português
  // Ex: "18/05/2026 às 12h" ou "2026-05-18 12:00"
  const regexBR = /(\d{1,2})\/(\d{1,2})\/(\d{4})[^\d]*(\d{1,2})h?:?(\d{0,2})/;
  const matchBR = valor.match(regexBR);
  if (matchBR) {
    const [, d, m, y, h, min] = matchBR;
    return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${(min||'00').padStart(2,'0')}:00`);
  }

  throw new Error(`Formato de data não reconhecido: ${valor}`);
}

export async function createEvent(dados) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const start = parseDataInicio(dados.data_inicio);
  const startDateTime = start.toISOString();
  const endDateTime = new Date(start.getTime() + 90 * 60 * 1000).toISOString();

  const event = {
    summary: dados.titulo,
    location: dados.local,
    description: dados.descricao,
    start: { dateTime: startDateTime, timeZone: 'America/Sao_Paulo' },
    end: { dateTime: endDateTime, timeZone: 'America/Sao_Paulo' },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'popup', minutes: 120 },
      ],
    },
  };

  const res = await calendar.events.insert({ calendarId, requestBody: event });
  return res.data;
}
