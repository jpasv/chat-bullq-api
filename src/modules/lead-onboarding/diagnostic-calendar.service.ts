import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { GoogleAuthService } from '../ai-agents/tools/client-ops/google-auth.service';
import { LeadOnboardingConfigService } from './lead-onboarding-config.service';

export class SlotTakenError extends Error {
  constructor(readonly startIso: string) {
    super(`horário ocupado: ${startIso}`);
  }
}

const HOUR = 3_600_000;
const FIRST_HOUR = 9; // primeiro bloco começa 9h
const LAST_START_HOUR = 19; // último bloco 19h-20h
const TZ = 'America/Sao_Paulo';
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/**
 * Agenda "Diagnósticos de IA – Pedro" (conta produtos@asv.digital). Oferece
 * blocos de 1h das 9h às 20h, todos os dias, a partir de amanhã, e cria o
 * evento com Meet. Usa a mesma credencial OAuth da Sofia (scope calendar).
 */
@Injectable()
export class DiagnosticCalendarService {
  private readonly logger = new Logger(DiagnosticCalendarService.name);

  constructor(
    private readonly auth: GoogleAuthService,
    private readonly config: LeadOnboardingConfigService,
  ) {}

  private get calendarId(): string {
    const id = this.config.calendarId;
    if (!id) throw new Error('ONBOARDING_CALENDAR_ID não configurado');
    return id;
  }

  async freeSlots(
    from: Date,
    days = 4,
    max = 6,
  ): Promise<Array<{ startIso: string; label: string }>> {
    const firstDay = brtMidnight(from, 1);
    const end = new Date(firstDay.getTime() + days * 24 * HOUR);
    const busy = await this.busy(firstDay, end);

    const slots: Array<{ startIso: string; label: string }> = [];
    for (let d = 0; d < days && slots.length < max; d++) {
      for (let h = FIRST_HOUR; h <= LAST_START_HOUR && slots.length < max; h++) {
        const start = new Date(firstDay.getTime() + (d * 24 + h) * HOUR);
        const stop = new Date(start.getTime() + HOUR);
        if (busy.some((b) => b.start < stop && b.end > start)) continue;
        slots.push({ startIso: start.toISOString(), label: label(start) });
      }
    }
    return slots;
  }

  async create(input: {
    startIso: string;
    attendees: string[];
    title: string;
    description: string;
  }): Promise<{ eventId: string; meetLink: string | null }> {
    const start = new Date(input.startIso);
    const end = new Date(start.getTime() + HOUR);
    const busy = await this.busy(start, end);
    if (busy.some((b) => b.start < end && b.end > start)) {
      throw new SlotTakenError(input.startIso);
    }

    const token = await this.auth.getCalendarToken();
    const resp = await axios.post(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
      {
        summary: input.title,
        description: input.description,
        start: { dateTime: start.toISOString(), timeZone: TZ },
        end: { dateTime: end.toISOString(), timeZone: TZ },
        attendees: input.attendees.map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
    );
    const ev = resp.data;
    const meetLink: string | null =
      ev.hangoutLink ??
      ev.conferenceData?.entryPoints?.find((e: { entryPointType: string }) => e.entryPointType === 'video')?.uri ??
      null;
    this.logger.log(`Diagnóstico criado ${ev.id} (${start.toISOString()})`);
    return { eventId: ev.id, meetLink };
  }

  private async busy(timeMin: Date, timeMax: Date): Promise<Array<{ start: Date; end: Date }>> {
    const token = await this.auth.getCalendarToken();
    const resp = await axios.post(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: TZ,
        items: [{ id: this.calendarId }],
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
    );
    const list = resp.data?.calendars?.[this.calendarId]?.busy ?? [];
    return list.map((b: { start: string; end: string }) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }
}

/** Meia-noite de Brasília do dia de `at` + dayOffset. */
function brtMidnight(at: Date, dayOffset = 0): Date {
  const local = new Date(at.getTime() - 3 * HOUR);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, 3));
}

/** "seg, 19/10 às 9h" em horário de Brasília. */
function label(at: Date): string {
  const local = new Date(at.getTime() - 3 * HOUR);
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${WEEKDAYS[local.getUTCDay()]}, ${dd}/${mm} às ${local.getUTCHours()}h`;
}
