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

// Envia áudio (PTT — push-to-talk, formato OGG/OPUS) como mensagem de voz no WhatsApp
export async function sendAudio(phone, audioBase64) {
  const payload = {
    phone,
    audio: `data:audio/ogg;base64,${audioBase64}`,
    waveform: true, // gera o "gráfico" da onda igual mensagem de voz nativa
  };
  await axios.post(`${BASE_URL}/send-audio`, payload, {
    headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN },
  });
}

// Mostra "digitando..." (ou "gravando áudio") no WhatsApp do cliente.
// status: 'composing' (digitando), 'recording' (gravando), 'paused' (parou).
// Falha silenciosa: se a Z-API rejeitar, não interrompe o envio da mensagem.
export async function sendChatState(phone, status = 'composing') {
  try {
    await axios.post(
      `${BASE_URL}/send-chat-state`,
      { phone, chatState: status },
      {
        headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN },
        timeout: 3000,
      }
    );
  } catch (e) {
    // Não é crítico — só loga e segue
    console.warn(`[ZAPI] sendChatState(${status}) falhou: ${e.message}`);
  }
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
