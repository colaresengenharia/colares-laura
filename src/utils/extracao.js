// Funções de extração reutilizáveis em vários módulos (server, agentes)

// Tenta extrair o nome do cliente a partir da mensagem dele via regex.
// Retorna o primeiro nome (e segundo, se houver) ou null se não conseguir.
export function extrairNomeFallback(mensagem) {
  if (!mensagem) return null;
  const padroes = [
    /(?:meu\s+nome\s+(?:é|eh)|me\s+chamo|sou\s+(?:o|a)?|aqui\s+(?:é|eh)\s+(?:o|a)?|pode\s+me\s+chamar\s+de)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç]+)?)/i,
  ];
  for (const re of padroes) {
    const m = mensagem.match(re);
    if (m && m[1]) {
      return m[1].trim().split(/\s+/).slice(0, 2).join(' ');
    }
  }
  return null;
}

// Retorna a saudação adequada ao horário atual em São Paulo: "Bom dia", "Boa tarde" ou "Boa noite".
export function saudacaoHorario() {
  const horaSP = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }),
    10,
  );
  if (horaSP >= 5 && horaSP < 12) return 'Bom dia';
  if (horaSP >= 12 && horaSP < 18) return 'Boa tarde';
  return 'Boa noite';
}
