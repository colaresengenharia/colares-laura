import { callClaude } from '../integrations/anthropic.js';
import { prompts } from '../prompts/system-prompts.js';
import { listarOcupadosProximosDias, BUFFER_ENTRE_VISITAS_MIN, DURACAO_VISITA_MIN } from '../integrations/calendar.js';

function getInfoTempo() {
  const agora = new Date();
  const dataAtual = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const horaAtual = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const diaSemana = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });

  // Calcula próximos 14 dias com nome do dia (em PT-BR)
  const proximos14 = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(agora.getTime() + i * 86400000);
    const dia = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const nome = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });
    proximos14.push(`${nome}: ${dia}`);
  }

  return `
INFORMAÇÕES DE TEMPO REAIS (use estas datas, NUNCA invente):
- Hoje: ${diaSemana}, ${dataAtual} ${horaAtual}
- Próximos 14 dias (use ESTA tabela pra qualquer referência de data):
${proximos14.map((p) => '  - ' + p).join('\n')}

REGRAS DE INTERPRETAÇÃO DE DATA:
- "amanhã" = o próximo dia depois de hoje
- "segunda", "terça" etc. = a próxima ocorrência desse dia da semana a partir de amanhã
- "semana que vem" = começa na próxima segunda
- "daqui a 2 semanas" = exatamente 14 dias a partir de hoje
- SEMPRE preencha "data" no formato DD/MM/AAAA usando a tabela acima como referência.
- SEMPRE verifique: o dia da semana que você fala precisa CASAR com a data que você fala. Ex: se hoje é domingo 17/05, "quinta" é 21/05 (não 22/05).
- NUNCA use datas do passado.

NÃO INVENTE RESTRIÇÕES:
- NÃO diga que uma data está "fora da janela", "fora da agenda", "muito longe" — qualquer data nos próximos 14 dias úteis (segunda-sexta) está disponível, exceto as que já estão na lista de VISITAS JÁ AGENDADAS.
- A única restrição real é: dias úteis (Seg-Qui 8h-17h, Sex 8h-16h), buffer de 2h entre visitas, e os horários da lista de visitas agendadas no contexto.
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
