import { google } from 'googleapis';

const SHEET_NAME = 'Página1';
const HEADERS = [
  'Data Contato', 'Nome', 'Telefone', 'Cidade', 'Bairro',
  'Tipo Imóvel', 'Serviço', 'Descrição', 'Urgência', 'Status Lead',
  'Tipo Agendamento', 'Data Agendada', 'Hora', 'Endereço', 'Observações',
];

function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function ensureHeaders() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A1:O1`,
  });

  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

export async function appendLead(dados) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  const row = [
    dados.data_contato || new Date().toLocaleString('pt-BR'),
    dados.nome || '',
    dados.telefone || '',
    dados.cidade || '',
    dados.bairro || '',
    dados.tipo_imovel || '',
    dados.servico || '',
    dados.descricao || '',
    dados.urgencia || '',
    dados.status_lead || '',
    dados.tipo_agendamento || '',
    dados.data_agendada || '',
    dados.hora || '',
    dados.endereco || '',
    dados.observacoes || '',
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_NAME}!A:O`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}
