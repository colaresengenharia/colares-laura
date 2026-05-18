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

// "Digitando..." no WhatsApp NÃO é possível via API — é limitação da plataforma.
// Esta função fica como no-op (não faz nada) para o resto do código não quebrar.
// Se um dia o WhatsApp/Z-API liberar isso, basta reativar o axios aqui.
export async function sendChatState(_phone, _status = 'composing') {
  return; // no-op
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

// --- Imagens ---
export function isImage(body) {
  if (!body) return false;
  if (body.type === 'image') return true;
  if (body.image?.imageUrl) return true;
  if (typeof body.mimetype === 'string' && body.mimetype.startsWith('image/')) return true;
  return false;
}

export function getImageMimeType(body) {
  return body?.image?.mimeType || body?.mimetype || 'image/jpeg';
}

export function getImageCaption(body) {
  return body?.image?.caption || body?.caption || '';
}

export async function downloadImageBase64(body) {
  const url = body?.image?.imageUrl ?? body?.imageUrl ?? null;
  if (!url) {
    console.warn('[IMAGE] Nenhuma URL de imagem. body.image:', JSON.stringify(body?.image)?.slice(0, 200));
    return null;
  }
  console.log('[IMAGE] Baixando de:', url.slice(0, 80));
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Client-Token': ZAPI_CLIENT_TOKEN },
  });
  return Buffer.from(resp.data).toString('base64');
}

// --- Documentos (PDF, etc) ---
export function isDocument(body) {
  if (!body) return false;
  if (body.type === 'document') return true;
  if (body.document?.documentUrl) return true;
  if (typeof body.mimetype === 'string' && body.mimetype.startsWith('application/')) return true;
  return false;
}

export function getDocumentCaption(body) {
  return body?.document?.caption || body?.caption || body?.document?.fileName || '';
}

export async function downloadDocumentBase64(body) {
  const url = body?.document?.documentUrl ?? body?.documentUrl ?? null;
  if (!url) {
    console.warn('[DOC] Nenhuma URL de documento. body.document:', JSON.stringify(body?.document)?.slice(0, 200));
    return null;
  }
  console.log('[DOC] Baixando de:', url.slice(0, 80));
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Client-Token': ZAPI_CLIENT_TOKEN },
  });
  return Buffer.from(resp.data).toString('base64');
}
