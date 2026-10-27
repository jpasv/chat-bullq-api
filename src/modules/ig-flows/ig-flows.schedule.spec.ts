import { dayLabel, nextDailyAt } from './ig-flows.schedule';

describe('nextDailyAt', () => {
  it('antes do horário agenda pra hoje', () => {
    expect(nextDailyAt('20:00', 0, new Date('2026-10-27T14:00:00-03:00')).toISOString()).toBe('2026-10-27T23:00:00.000Z');
  });

  it('depois do horário agenda pra amanhã', () => {
    expect(nextDailyAt('20:00', 0, new Date('2026-10-27T20:30:00-03:00')).toISOString()).toBe('2026-10-28T23:00:00.000Z');
  });

  it('dentro da tolerância mantém hoje (dispara na hora)', () => {
    expect(nextDailyAt('20:00', 60, new Date('2026-10-27T20:30:00-03:00')).toISOString()).toBe('2026-10-27T23:00:00.000Z');
  });

  it('madrugada em Brasília (dia seguinte em UTC) agenda pro mesmo dia local', () => {
    expect(nextDailyAt('20:00', 0, new Date('2026-10-27T22:30:00-03:00')).toISOString()).toBe('2026-10-28T23:00:00.000Z');
    expect(nextDailyAt('20:00', 0, new Date('2026-10-28T01:00:00-03:00')).toISOString()).toBe('2026-10-28T23:00:00.000Z');
  });
});

describe('dayLabel', () => {
  it('hoje antes do horário, amanhã depois', () => {
    expect(dayLabel('20:00', 0, new Date('2026-10-27T19:59:00-03:00'))).toBe('hoje');
    expect(dayLabel('20:00', 0, new Date('2026-10-27T20:01:00-03:00'))).toBe('amanhã');
    expect(dayLabel('20:00', 60, new Date('2026-10-27T20:30:00-03:00'))).toBe('hoje');
  });
});
