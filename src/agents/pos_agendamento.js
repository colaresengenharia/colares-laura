import { callClaude } from '../integrations/anthropic.js';
import { prompts } from '../prompts/system-prompts.js';

export async function pos_agendamento(mensagem, historico, lead, phone) {
  const dados = JSON.parse(lead?.dados || '{}');

  const contexto = `
VISITA JÁ AGENDADA (use estes dados ao se referir à visita):
- Cliente: ${lead?.nome || dados.nome || 'cliente'}
- Data: ${dados.data || 'não definida'}
- Hora: ${dados.hora || 'não definida'}
- Endereço: ${dados.endereco_completo || dados.endereco || 'não definido'}

Telefone do cliente (WhatsApp): ${phone || dados.telefone || 'não identificado'}
NÃO pergunte o telefone, nome, ou se apresente — vocês já se conhecem.
`;

  const messages = [
    ...historico.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: mensagem },
  ];

  return callClaude(prompts.pos_agendamento + '\n\nCONTEXTO:\n' + contexto, messages);
}
