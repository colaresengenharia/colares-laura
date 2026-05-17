import { callClaude } from '../integrations/anthropic.js';
import { prompts } from '../prompts/system-prompts.js';

export async function agendador(mensagem, historico, lead) {
  const contexto = `Dados já coletados: ${JSON.stringify(JSON.parse(lead?.dados || '{}'))}`;

  const messages = [
    ...historico.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: mensagem },
  ];

  return callClaude(prompts.agendador + '\n\nCONTEXTO:\n' + contexto, messages);
}
