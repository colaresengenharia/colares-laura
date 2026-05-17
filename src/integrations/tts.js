import { google } from 'googleapis';

// Voz primária: Neural2-C — voz feminina mais madura/profissional disponível em PT-BR
const VOZ_PRIMARIA = 'pt-BR-Neural2-C';
// Fallback: Wavenet-C — alternativa mais conversacional
const VOZ_FALLBACK = 'pt-BR-Wavenet-C';
// Velocidade levemente acima do natural (1.0)
const SPEAKING_RATE = 1.15;
// Pitch baixo (semitons): aproxima de uma voz mais grave / "rouca"
const PITCH = -7.0;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedToken;

  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  cachedToken = t.token;
  cachedTokenExpiresAt = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

async function callSynthesize(body) {
  const token = await getAccessToken();
  const resp = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) {
    const err = new Error(json?.error?.message || 'TTS falhou');
    err.status = resp.status;
    err.googleError = json?.error;
    throw err;
  }
  return json.audioContent; // base64
}

export async function sintetizarVoz(texto) {
  if (!texto || !texto.trim()) return null;

  // Limpa emojis e caracteres que podem atrapalhar a síntese
  const textoLimpo = texto
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  const audioConfig = {
    audioEncoding: 'OGG_OPUS',
    speakingRate: SPEAKING_RATE,
    pitch: PITCH,
  };

  // Tentativa 1: voz primária (Wavenet-A — mais conversacional brasileira)
  try {
    return await callSynthesize({
      input: { text: textoLimpo },
      voice: { languageCode: 'pt-BR', name: VOZ_PRIMARIA },
      audioConfig,
    });
  } catch (e) {
    console.warn(`[TTS] Voz primária falhou (${e.status}): ${e.message}. Caindo pra fallback.`);
  }

  // Tentativa 2: fallback (Neural2-C)
  return await callSynthesize({
    input: { text: textoLimpo },
    voice: { languageCode: 'pt-BR', name: VOZ_FALLBACK },
    audioConfig,
  });
}
