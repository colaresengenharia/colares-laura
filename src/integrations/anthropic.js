import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

// Descreve uma imagem enviada pelo cliente (foto de defeito, parte do imóvel, etc).
// O retorno vira "texto" da mensagem do cliente — daí o fluxo segue normal pelos agentes.
export async function descreverImagem(base64, mediaType = 'image/jpeg') {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: `Esta é uma foto enviada por um cliente para uma empresa de engenharia/construção em São Paulo. O cliente NÃO escreveu mensagem — só mandou a foto. Você precisa entender o que ele provavelmente quer mostrar para a Laura responder bem.

Analise CUIDADOSAMENTE a imagem e descreva em português brasileiro em até 4 frases, cobrindo (na ordem):

1. ONDE foi tirada: qual cômodo ou parte do imóvel (sala, banheiro, fachada, laje, garagem, parede externa, teto, pilar, viga, sacada, telhado, área externa, etc).
2. O QUE aparece: descreva objetivamente o que se vê (paredes, piso, teto, estrutura visível, móveis, etc).
3. PROBLEMAS TÉCNICOS visíveis: trincas (finas/largas/diagonais/horizontais), infiltração (manchas, mofo, bolor, descolamento de pintura, eflorescência), corrosão de armadura (manchas de ferrugem, concreto estufado), fissuras estruturais, descolamento de revestimento, umidade ascendente, danos estruturais, etc. SEJA ESPECÍFICO.
4. PROVÁVEL INTENÇÃO DO CLIENTE: o que ele está perguntando/mostrando? (ex: "está mostrando uma infiltração na laje do banheiro pra pedir orçamento de recuperação", "está mostrando trincas em pilar pra avaliação estrutural", "está mostrando um cômodo que quer reformar", etc).

Se não conseguir identificar problema técnico claro, diga isso explicitamente. Seja técnica, objetiva e completa. Responda apenas com a descrição/análise (sem preâmbulos).` }
        ],
      }],
    });
    return response.content[0]?.text?.trim() || null;
  } catch (e) {
    console.error('[IMAGE] Falha ao descrever:', e.message);
    return null;
  }
}

// Descreve/resume um documento PDF enviado pelo cliente.
export async function descreverDocumento(base64) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Este é um documento PDF que um cliente enviou pra uma empresa de engenharia. Resuma em 3-4 frases em português brasileiro: que tipo de documento é (laudo, orçamento, projeto, planta, etc), pontos principais, e qualquer dado relevante pra um diagnóstico de engenharia. Responda apenas com o resumo.' }
        ],
      }],
    });
    return response.content[0]?.text?.trim() || null;
  } catch (e) {
    console.error('[DOC] Falha ao descrever:', e.message);
    return null;
  }
}

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
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // Tenta limpar caracteres de controle e re-parsear
      try {
        const cleaned = match[0].replace(/[\x00-\x1F\x7F]/g, ' ');
        return JSON.parse(cleaned);
      } catch {
        // Cai no fallback abaixo
      }
    }
  }

  // Fallback: Claude respondeu texto puro (sem JSON) — usa o texto como resposta_cliente
  // pra não deixar o cliente no vácuo. Loga warning pra investigarmos depois.
  const fallback = (text || '').trim();
  if (fallback) {
    console.warn(`[CLAUDE] Resposta sem JSON, usando texto puro como resposta: ${fallback.slice(0, 100)}`);
    return { resposta_cliente: fallback };
  }

  throw new Error('Claude retornou resposta vazia.');
}
