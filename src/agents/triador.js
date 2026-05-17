import { callClaude } from '../integrations/anthropic.js';
import { prompts } from '../prompts/system-prompts.js';

export async function triador(mensagem, historico) {
  const messages = [
    ...historico.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: mensagem },
  ];

  return callClaude(prompts.triador, messages);
}
