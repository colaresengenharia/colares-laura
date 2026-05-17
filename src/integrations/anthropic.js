import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

export async function callClaude(systemPrompt, messages) {
  const messagesWithReminder = [
    ...messages,
    {
      role: 'user',
      content: 'IMPORTANTE: Retorne APENAS o JSON solicitado, sem texto adicional antes ou depois.',
    },
  ];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: messagesWithReminder,
  });

  const text = response.content[0]?.text ?? '';
  return parseJson(text);
}

function parseJson(text) {
  // Tenta extrair JSON de qualquer lugar da resposta
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude não retornou JSON válido: ${text.slice(0, 100)}`);
  try {
    return JSON.parse(match[0]);
  } catch {
    // Tenta limpar e re-parsear
    const cleaned = match[0].replace(/[\x00-\x1F\x7F]/g, ' ');
    return JSON.parse(cleaned);
  }
}
