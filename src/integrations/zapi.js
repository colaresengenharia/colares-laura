import axios from 'axios';

const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;

const BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

export async function sendMessage(phone, message) {
  const url = `${BASE_URL}/send-text`;

  await axios.post(
    url,
    { phone, message },
    {
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': ZAPI_CLIENT_TOKEN,
      },
    }
  );
}

export function extractPhone(webhookBody) {
  return webhookBody?.phone ?? webhookBody?.from ?? null;
}

export function extractMessage(webhookBody) {
  return (
    webhookBody?.text?.message ??
    webhookBody?.message ??
    ''
  );
}
