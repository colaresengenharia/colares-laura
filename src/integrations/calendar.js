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

function montarEventBody(dados) {
  const start = parseDataInicio(dados.data_inicio);
  const startDateTime = start.toISOString();
  const endDateTime = new Date(start.getTime() + 90 * 60 * 1000).toISOString();

  return {
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
}

export async function createEvent(dados) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const res = await calendar.events.insert({
    calendarId,
    requestBody: montarEventBody(dados),
  });
  return res.data;
}

export async function updateEvent(eventId, dados) {
  if (!eventId) throw new Error('eventId obrigatório para update');
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const res = await calendar.events.update({
    calendarId,
    eventId,
    requestBody: montarEventBody(dados),
  });
  return res.data;
}

// --- Regras de disponibilidade ---
export const DURACAO_VISITA_MIN = 90;
export const BUFFER_ENTRE_VISITAS_MIN = 120;

// Lista todos os eventos do calendário entre duas datas
export async function listEventsBetween(startDate, endDate) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const res = await calendar.events.list({
    calendarId,
    timeMin: startDate.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });
  return res.data.items || [];
}

// Verifica se um horário tem conflito (já existe visita próxima considerando o buffer).
// Retorna { conflito: bool, eventoBloqueador: {summary, inicio, fim} | null }.
// Se ignoreEventId for passado, ignora aquele evento (útil ao reagendar — não conflitua consigo mesmo).
export async function temConflito(dataInicioISO, ignoreEventId = null) {
  const novoInicio = new Date(dataInicioISO);
  const novoFim = new Date(novoInicio.getTime() + DURACAO_VISITA_MIN * 60_000);

  // Busca eventos numa janela ampla ao redor (24h antes e depois) — suficiente pra detectar conflitos
  const janelaInicio = new Date(novoInicio.getTime() - 24 * 60 * 60_000);
  const janelaFim = new Date(novoFim.getTime() + 24 * 60 * 60_000);
  const eventos = await listEventsBetween(janelaInicio, janelaFim);

  for (const e of eventos) {
    if (ignoreEventId && e.id === ignoreEventId) continue;
    if (!e.start?.dateTime || !e.end?.dateTime) continue; // ignora eventos dia-inteiro

    const eIni = new Date(e.start.dateTime);
    const eFim = new Date(e.end.dateTime);
    const bufferMs = BUFFER_ENTRE_VISITAS_MIN * 60_000;
    const proibidoIni = new Date(eIni.getTime() - bufferMs);
    const proibidoFim = new Date(eFim.getTime() + bufferMs);

    // Conflito = sobreposição da nova visita com a janela proibida do evento existente
    if (novoInicio < proibidoFim && novoFim > proibidoIni) {
      return {
        conflito: true,
        eventoBloqueador: {
          summary: e.summary || 'Visita',
          inicio: eIni.toISOString(),
          fim: eFim.toISOString(),
        },
      };
    }
  }

  return { conflito: false, eventoBloqueador: null };
}

// Lista compromissos dos próximos N dias num formato compacto pra inserir no prompt do agendador
export async function listarOcupadosProximosDias(dias = 7) {
  const agora = new Date();
  const fim = new Date(agora.getTime() + dias * 24 * 60 * 60_000);
  const eventos = await listEventsBetween(agora, fim);
  return eventos
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => {
      const ini = new Date(e.start.dateTime);
      const fim = new Date(e.end.dateTime);
      const fmt = (d) =>
        d.toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
      return `${fmt(ini)} até ${fmt(fim)}`;
    });
}
