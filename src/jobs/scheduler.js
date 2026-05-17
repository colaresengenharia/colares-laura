import cron from 'node-cron';
import { rodarReativacao } from './reativacao.js';
import { rodarLembrete } from './lembrete.js';

let rodando = false;

async function ciclo() {
  if (rodando) {
    console.log('[SCHEDULER] ciclo anterior ainda em execução, pulando.');
    return;
  }
  rodando = true;
  try {
    await rodarLembrete();
    await rodarReativacao();
  } catch (e) {
    console.error('[SCHEDULER] erro:', e.message);
  } finally {
    rodando = false;
  }
}

export function iniciarScheduler() {
  // Roda a cada hora cheia (00 min). Granularidade suficiente para janelas de 48h/5d/24h.
  cron.schedule('0 * * * *', ciclo, { timezone: 'America/Sao_Paulo' });
  console.log('[SCHEDULER] Cron iniciado (executa de hora em hora).');

  // Um disparo inicial 1 min após boot, pra não esperar até a próxima hora cheia
  setTimeout(ciclo, 60_000);
}
