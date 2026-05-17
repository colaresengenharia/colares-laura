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
  // Roda a cada 5 min. Granularidade fina o suficiente para a janela de 15 min de reativação.
  cron.schedule('*/5 * * * *', ciclo, { timezone: 'America/Sao_Paulo' });
  console.log('[SCHEDULER] Cron iniciado (executa a cada 5 minutos).');

  // Um disparo inicial 1 min após boot, pra não esperar até a próxima janela
  setTimeout(ciclo, 60_000);
}
