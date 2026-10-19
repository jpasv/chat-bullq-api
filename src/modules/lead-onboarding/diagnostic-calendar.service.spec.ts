import axios from 'axios';
import { DiagnosticCalendarService, SlotTakenError } from './diagnostic-calendar.service';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;
const brt = (iso: string) => new Date(`${iso}-03:00`);

function build(busy: Array<{ start: string; end: string }>) {
  mocked.post.mockImplementation(async (url: string) => {
    if (url.includes('freeBusy')) {
      return { data: { calendars: { cal1: { busy } } } } as any;
    }
    return { data: { id: 'ev1', hangoutLink: 'https://meet.google.com/abc' } } as any;
  });
  const auth = { getCalendarToken: jest.fn().mockResolvedValue('tok') };
  const config = { calendarId: 'cal1' };
  return new DiagnosticCalendarService(auth as any, config as any);
}

describe('DiagnosticCalendarService.freeSlots', () => {
  beforeEach(() => mocked.post.mockReset());

  it('começa amanhã às 9h, pula horário ocupado e nunca oferece 20h', async () => {
    const svc = build([
      { start: brt('2026-10-19T14:00:00').toISOString(), end: brt('2026-10-19T15:00:00').toISOString() },
    ]);
    const slots = await svc.freeSlots(brt('2026-10-18T16:30:00'), 1, 20);
    const hours = slots.map((s) => new Date(s.startIso).getTime());
    expect(slots[0].startIso).toBe(brt('2026-10-19T09:00:00').toISOString());
    expect(hours).not.toContain(brt('2026-10-19T14:00:00').getTime());
    expect(hours).not.toContain(brt('2026-10-19T20:00:00').getTime());
    expect(hours).toContain(brt('2026-10-19T19:00:00').getTime());
    expect(slots).toHaveLength(10); // 9h..19h = 11 blocos, menos o das 14h
    expect(slots[0].label).toBe('amanhã às 9h');
  });

  it('respeita o máximo pedido', async () => {
    const svc = build([]);
    expect(await svc.freeSlots(brt('2026-10-18T16:30:00'), 4, 6)).toHaveLength(6);
  });
});

describe('DiagnosticCalendarService.create', () => {
  beforeEach(() => mocked.post.mockReset());

  it('horário ocupado na hora de criar → SlotTakenError', async () => {
    const svc = build([
      { start: brt('2026-10-19T10:00:00').toISOString(), end: brt('2026-10-19T11:00:00').toISOString() },
    ]);
    await expect(
      svc.create({
        startIso: brt('2026-10-19T10:00:00').toISOString(),
        attendees: ['a@b.com'],
        title: 't',
        description: 'd',
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('cria com Meet e 60 minutos', async () => {
    const svc = build([]);
    const r = await svc.create({
      startIso: brt('2026-10-19T10:00:00').toISOString(),
      attendees: ['a@b.com'],
      title: 'Diagnóstico de IA – Mayara',
      description: 'Objetivo',
    });
    expect(r).toEqual({ eventId: 'ev1', meetLink: 'https://meet.google.com/abc' });
    const body = mocked.post.mock.calls.find(([u]) => String(u).includes('/events'))![1] as any;
    expect(new Date(body.end.dateTime).getTime() - new Date(body.start.dateTime).getTime()).toBe(3_600_000);
    expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
  });
});


describe('slotLabel', () => {
  const { slotLabel } = require('./diagnostic-calendar.service');
  const now = new Date('2026-10-19T17:00:00.000Z'); // seg 14h BRT
  it('amanhã, dia da semana e data', () => {
    expect(slotLabel(new Date('2026-10-20T13:00:00.000Z'), now)).toBe('amanhã às 10h');
    expect(slotLabel(new Date('2026-10-22T17:00:00.000Z'), now)).toBe('quinta às 14h');
    expect(slotLabel(new Date('2026-10-27T12:00:00.000Z'), now)).toBe('terça, 27/10, às 9h');
  });
});
