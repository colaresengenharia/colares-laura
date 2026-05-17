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
  return (
    webhookBody?.type === 'audio' ||
    webhookBody?.audio === true ||
    !!webhookBody?.audio?.audioUrl ||
    (typeof webhookBody?.body === 'string' && webhookBody.body.startsWith('data:audio'))
  );
}

export async function downloadAudioBase64(webhookBody) {
  // Formato 1: áudio já em base64 no campo body
  if (typeof webhookBody?.body === 'string' && webhookBody.body.startsWith('data:audio')) {
    return webhookBody.body.split(',')[1];
  }

  // Formato 2: URL do áudio
  const url = webhookBody?.audio?.audioUrl ?? webhookBody?.audioUrl ?? null;
  if (!url) return null;

  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Client-Token': ZAPI_CLIENT_TOKEN },
  });

  return Buffer.from(resp.data).toString('base64');
}
