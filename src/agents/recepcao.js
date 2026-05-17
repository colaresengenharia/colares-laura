import { callClaude } from '../integrations/anthropic.js';
import { prompts } from '../prompts/system-prompts.js';
import { extrairNomeFallback, saudacaoHorario } from '../utils/extracao.js';

// Resposta determinística pedindo o nome (usada na 1ª mensagem quando cliente não se apresentou).
// Garante 100% que a Laura SEMPRE pede o nome de cara, sem depender do Claude obedecer o prompt.
function respostaPedindoNome() {
  const saudacao = saudacaoHorario();
  const variantes = [
    `${saudacao}! Sou a Laura. Antes da gente conversar, como posso te chamar?`,
    `${saudacao}! Aqui é a Laura. Qual seu nome?`,
    `${saudacao}! Sou a Laura. Com quem tenho o prazer de falar?`,
    `${saudacao}! Sou a Laura. Pra começar, me diz seu nome?`,
  ];
  const escolhida = variantes[Math.floor(Math.random() * variantes.length)];
  return {
    resposta_cliente: escolhida,
    dados_coletados: { nome: '', tipo_servico_inicial: '' },
    lgpd_consentido: false,
    proximo_agente: 'recepcao', // continua na recepção até o cliente dar o nome
  };
}

export async function recepcao(mensagem, historico, lead) {
  const dadosLead = JSON.parse(lead?.dados || '{}');
  const nomeAtual = dadosLead.nome || lead?.nome || '';

  // Hard-rule: se é primeira mensagem (sem histórico de assistant) E ainda não temos o nome
  // E o cliente também não disse o nome agora, mandamos resposta pronta pedindo o nome.
  // Isso garante o comportamento independente do Claude obedecer ao prompt.
  const primeiraMensagem = historico.filter((m) => m.role === 'assistant').length === 0;
  const nomeNaMensagem = extrairNomeFallback(mensagem);
  if (primeiraMensagem && !nomeAtual && !nomeNaMensagem) {
    return respostaPedindoNome();
  }

  const contexto = `
Dados já coletados: ${JSON.stringify(dadosLead)}
LGPD já enviado: ${lead?.lgpd_consentido ? 'sim' : 'não'}
Nome do cliente: ${nomeAtual || nomeNaMensagem || '(ainda não sabemos)'}
`;

  const messages = [
    ...historico.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: mensagem },
  ];

  return callClaude(prompts.recepcao + '\n\nCONTEXTO:\n' + contexto, messages);
}
