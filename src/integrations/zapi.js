import axios from 'axios';

const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;

const BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

export async function sendMessage(phone, message) {
  await axios.post(
    `${BASE_URL}/send-text`,
    { phone, message },
    { headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN } }
  );
}

export function extractPhone(webhookBody) {
  return webhookBody?.phone ?? webhookBody?.from ?? null;
}

export function extractMessage(webhookBody) {
  return webhookBody?.text?.message ?? webhookBody?.message ?? '';
}

export function isAudio(webhookBody) {
  if (!webhookBody) return false;
  const type = webhookBody.type;
  if (type === 'audio' || type === 'ptt') return true;
  if (webhookBody.audio === true) return true;
  if (webhookBody.audio?.audioUrl) return true;
  if (webhookBody.audioUrl) return true;
  if (typeof webhookBody.mimetype === 'string' && webhookBody.mimetype.startsWith('audio/')) return true;
  if (typeof webhookBody.body === 'string' && webhookBody.body.startsWith('data:audio')) return true;
  return false;
}

export async function downloadAudioBase64(webhookBody) {
  // Formato 1: base64 inline no campo body
  if (typeof webhookBody?.body === 'string' && webhookBody.body.startsWith('data:audio')) {
    return webhookBody.body.split(',')[1];
  }

  // Formato 2: URL do áudio
  const url = webhookBody?.audio?.audioUrl ?? webhookBody?.audioUrl ?? null;
  if (!url) {
    console.warn('[AUDIO] Nenhuma URL de áudio encontrada. body.audio:', JSON.stringify(webhookBody?.audio));
    return null;
  }

  console.log('[AUDIO] Baixando de:', url.slice(0, 80));
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Client-Token': ZAPI_CLIENT_TOKEN },
  });

  return Buffer.from(resp.data).toString('base64');
}
