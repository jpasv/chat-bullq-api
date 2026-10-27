/** Brasil sem horário de verão desde 2019: Brasília = UTC-3. */
const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function brtMidnightUtc(date: Date): number {
  const local = new Date(date.getTime() + BRT_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BRT_OFFSET_MS;
}

/**
 * Próxima ocorrência de `time` (HH:mm, Brasília). Até `graceMinutes` depois do
 * horário ainda conta a de hoje, ou seja, dispara na hora.
 */
export function nextDailyAt(time: string, graceMinutes = 0, now = new Date()): Date {
  const [h, m] = time.split(':').map(Number);
  const today = brtMidnightUtc(now) + (h * 60 + m) * 60_000;
  return new Date(now.getTime() > today + graceMinutes * 60_000 ? today + DAY_MS : today);
}

/** "hoje" ou "amanhã" conforme a próxima ocorrência de `time` (Brasília). */
export function dayLabel(time: string, graceMinutes = 0, now = new Date()): string {
  return brtMidnightUtc(nextDailyAt(time, graceMinutes, now)) === brtMidnightUtc(now) ? 'hoje' : 'amanhã';
}
