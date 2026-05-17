import { callClaude } from '../integrations/anthropic.js';
import { prompts } from '../prompts/system-prompts.js';
import { listarOcupadosProximosDias, BUFFER_ENTRE_VISITAS_MIN, DURACAO_VISITA_MIN } from '../integrations/calendar.js';

function getInfoTempo() {
  const agora = new Date();
  const dataAtual = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const horaAtual = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const diaSemana = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });

  // Calcula próximos 7 dias com nome do dia (em PT-BR)
  const proximos7 = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(agora.getTime() + i * 86400000);
    const dia = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const nome = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });
    proximos7.push(`${nome}: ${dia}`);
  }

  return `
INFORMAÇÕES DE TEMPO REAIS (use estas datas, NUNCA invente):
- Hoje: ${diaSemana}, ${dataAtual} ${horaAtual}
- Próximos 7 dias:
${proximos7.map((p) => '  - ' + p).join('\n')}

REGRAS:
- "amanhã" = o próximo dia depois de hoje
- "segunda", "terça" etc. = a próxima ocorrência desse dia da semana a partir de amanhã
- SEMPRE preencha "data" no formato DD/MM/AAAA usando as datas acima como referência.
- NUNCA use datas do passado.
`;
}

export async function agendador(mensagem, historico, lead, phone) {
  const dados = JSON.parse(lead?.dados || '{}');

  // Busca compromissos já agendados nos próximos 7 dias para o Claude evitar conflitos
  let ocupados = [];
  try {
    ocupados = await listarOcupadosProximosDias(7);
  } catch (e) {
    console.warn('[AGENDADOR] Falhou ao consultar Calendar:', e.message);
  }

  const blocoOcupados = ocupados.length
    ? `\nVISITAS JÁ AGENDADAS (NÃO OFEREÇA NEM CONFIRME ESTES HORÁRIOS NEM HORÁRIOS PRÓXIMOS):\n${ocupados.map((o) => '  - ' + o).join('\n')}\n\nIMPORTANTE: cada visita dura ${DURACAO_VISITA_MIN} minutos. É preciso ter pelo menos ${BUFFER_ENTRE_VISITAS_MIN} minutos de intervalo antes E depois de cada visita já agendada (tempo de deslocamento em São Paulo). Se o cliente pedir um horário ocupado ou próximo demais, ofereça uma alternativa LIVRE.`
    : '\nNão há visitas agendadas nos próximos 7 dias — qualquer horário comercial está livre.';

  const contexto = `
Dados coletados: ${JSON.stringify(dados)}
Telefone do cliente (WhatsApp): ${phone || dados.telefone || 'não identificado'}
NÃO pergunte o telefone — já está registrado automaticamente.

${getInfoTempo()}
${blocoOcupados}
`;

  const messages = [
    ...historico.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: mensagem },
  ];

  return callClaude(prompts.agendador + '\n\nCONTEXTO:\n' + contexto, messages);
}
