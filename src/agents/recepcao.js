import { callClaude } from '../integrations/anthropic.js';
import { prompts } from '../prompts/system-prompts.js';

export async function recepcao(mensagem, historico, lead) {
  const contexto = `
Dados já coletados: ${JSON.stringify(JSON.parse(lead?.dados || '{}'))}
LGPD já enviado: ${lead?.lgpd_consentido ? 'sim' : 'não'}
`;

  const messages = [
    ...historico.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: mensagem },
  ];

  return callClaude(prompts.recepcao + '\n\nCONTEXTO:\n' + contexto, messages);
}
