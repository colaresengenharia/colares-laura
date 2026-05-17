import { google } from 'googleapis';

function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

export async function createEvent(dados) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const startDateTime = new Date(`${dados.data_inicio}`).toISOString();
  const endDateTime = new Date(
    new Date(startDateTime).getTime() + 90 * 60 * 1000
  ).toISOString();

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
