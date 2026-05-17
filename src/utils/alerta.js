import { sendMessage } from '../integrations/zapi.js';

// Cooldown: o mesmo erro não dispara mais de 1 alerta por hora (evita spam)
const COOLDOWN_MS = 60 * 60_000;
const ultimosAlertas = new Map();

function deveAlertar(chave) {
  const ultimo = ultimosAlertas.get(chave) || 0;
  if (Date.now() - ultimo < COOLDOWN_MS) return false;
  ultimosAlertas.set(chave, Date.now());
  return true;
}

/**
 * Envia alerta ao admin via WhatsApp. No-op se ADMIN_PHONE não estiver setado.
 *
 * @param {string} categoria - chave curta para agrupar/throttle (ex: 'zapi', 'claude', 'sheets')
 * @param {string} titulo - título curto do alerta
 * @param {string} detalhe - detalhe do erro (mensagem, contexto)
 */
export async function alertarAdmin(categoria, titulo, detalhe = '') {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) return; // alertas desligados se variável não setada

  // Throttling: mesma categoria não dispara mais de 1x por hora
  if (!deveAlertar(categoria)) {
    console.log(`[ALERTA] ${categoria}: silenciado por throttle (1/hora)`);
    return;
  }

  const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const msg = `🚨 *Alerta Laura — ${titulo}*\n\n${detalhe || '(sem detalhes)'}\n\n_${ts}_`;

  try {
    await sendMessage(adminPhone, msg);
    console.log(`[ALERTA] Enviado para admin: ${categoria}`);
  } catch (e) {
    // Não pode chamar alertarAdmin recursivamente. Só loga.
    console.error(`[ALERTA] Falha ao enviar alerta (${categoria}):`, e.message);
  }
}

// Alerta de inicialização (uma vez por boot). Ajuda a confirmar que o sistema voltou após uma queda.
export async function alertarBoot() {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) return;
  try {
    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    await sendMessage(adminPhone, `✅ Laura online (servidor reiniciado em ${ts})`);
  } catch (e) {
    console.error('[ALERTA] Falha no alerta de boot:', e.message);
  }
}
