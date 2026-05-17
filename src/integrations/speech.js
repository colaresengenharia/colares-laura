import { google } from 'googleapis';
import axios from 'axios';

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

let _authClient = null;

async function getAccessToken() {
  if (!_authClient) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
    _authClient = await auth.getClient();
  }
  const { token } = await _authClient.getAccessToken();
  return token;
}

export async function transcribeAudio(base64Audio) {
  try {
    const token = await getAccessToken();
    const response = await axios.post(
      'https://speech.googleapis.com/v1/speech:recognize',
      {
        config: {
          encoding: 'OGG_OPUS',
          sampleRateHertz: 16000,
          languageCode: 'pt-BR',
          enableAutomaticPunctuation: true,
        },
        audio: { content: base64Audio },
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const transcript = response.data.results
      ?.map((r) => r.alternatives?.[0]?.transcript ?? '')
      .join(' ')
      .trim();

    return transcript || null;
  } catch (e) {
    console.error('[AUDIO] Transcrição Google STT falhou:', e.response?.data?.error?.message ?? e.message);
    return null;
  }
}
