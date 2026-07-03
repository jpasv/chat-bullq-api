import { Injectable, Logger } from '@nestjs/common';
import { AutomationTrigger } from '@prisma/client';
import { AutomationEventPayload } from '../automations.types';

// ─── Condition shape ────────────────────────────────────────────────
//
// Two-level structure (groups OR > rules AND):
//
//   {
//     match: "OR" | "AND",
//     groups: [
//       { match: "AND" | "OR", rules: [{ field, op, value }, ...] },
//       ...
//     ]
//   }
//
// Empty groups array OR `null` conditions = always match. This is the
// "no filter" default — fires on every event of the trigger.

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'in'
  | 'not_in'
  | 'is_set'
  | 'is_not_set';

export interface ConditionRule {
  field: string;
  op: ConditionOperator;
  value?: string | number | boolean | string[] | number[] | null;
}

export interface ConditionGroup {
  match: 'AND' | 'OR';
  rules: ConditionRule[];
}

export interface ConditionRoot {
  match: 'AND' | 'OR';
  groups: ConditionGroup[];
}

// ─── Field registry per trigger ──────────────────────────────────────
//
// Single source of truth for which fields a UI can offer per trigger.
// Each entry maps field-name → resolver that pulls the value out of an
// event payload. Adding a new condition field = one entry here.
//
// The save-time validator MUST consult this map to refuse rules that
// reference unknown fields (defense against UI bugs / stale clients).
export type FieldResolver = (p: AutomationEventPayload) => unknown;

export const FIELDS_BY_TRIGGER: Record<
  AutomationTrigger,
  Record<string, FieldResolver>
> = {
  [AutomationTrigger.TAG_ADDED]: {
    tagId: (p) => (p as any).tagId,
    target: (p) => (p as any).target,
    contactId: (p) => p.contactId,
    conversationId: (p) => p.conversationId,
    channelId: (p) => p.channelId,
  },
  [AutomationTrigger.TAG_REMOVED]: {
    tagId: (p) => (p as any).tagId,
    target: (p) => (p as any).target,
    contactId: (p) => p.contactId,
    conversationId: (p) => p.conversationId,
    channelId: (p) => p.channelId,
  },
  [AutomationTrigger.MESSAGE_RECEIVED]: {
    body: (p) => (p as any).body,
    type: (p) => (p as any).type,
    hasAttachment: (p) => (p as any).hasAttachment,
    channelId: (p) => p.channelId,
    contactId: (p) => p.contactId,
    conversationId: (p) => p.conversationId,
  },
  [AutomationTrigger.CONVERSATION_STATUS_CHANGED]: {
    fromStatus: (p) => (p as any).fromStatus,
    toStatus: (p) => (p as any).toStatus,
    channelId: (p) => p.channelId,
    contactId: (p) => p.contactId,
    conversationId: (p) => p.conversationId,
  },
  [AutomationTrigger.CONVERSATION_ASSIGNED]: {
    fromAssigneeId: (p) => (p as any).fromAssigneeId,
    toAssigneeId: (p) => (p as any).toAssigneeId,
    channelId: (p) => p.channelId,
    contactId: (p) => p.contactId,
    conversationId: (p) => p.conversationId,
  },
  [AutomationTrigger.CONVERSATION_CREATED]: {
    conversationId: (p) => p.conversationId,
    contactId: (p) => p.contactId,
    channelId: (p) => p.channelId,
  },
};

// ─── Evaluator ───────────────────────────────────────────────────────

@Injectable()
export class ConditionsEvaluator {
  private readonly logger = new Logger(ConditionsEvaluator.name);

  evaluate(
    trigger: AutomationTrigger,
    conditions: unknown,
    payload: AutomationEventPayload,
  ): boolean {
    // Treat anything that doesn't shape as a ConditionRoot with at least
    // one rule as "always match". This makes "no conditions" UX obvious:
    // user creates a regra com 0 grupos → fires no every event.
    if (!this.isRoot(conditions)) return true;
    if (conditions.groups.length === 0) return true;

    const fields = FIELDS_BY_TRIGGER[trigger];
    if (!fields) {
      this.logger.warn(`No field registry for trigger ${trigger} — refusing`);
      return false;
    }

    const groupResults = conditions.groups.map((g) =>
      this.evaluateGroup(g, fields, payload),
    );
    return conditions.match === 'AND'
      ? groupResults.every(Boolean)
      : groupResults.some(Boolean);
  }

  private evaluateGroup(
    group: ConditionGroup,
    fields: Record<string, FieldResolver>,
    payload: AutomationEventPayload,
  ): boolean {
    if (!group.rules || group.rules.length === 0) return true;
    const ruleResults = group.rules.map((rule) =>
      this.evaluateRule(rule, fields, payload),
    );
    return group.match === 'AND'
      ? ruleResults.every(Boolean)
      : ruleResults.some(Boolean);
  }

  private evaluateRule(
    rule: ConditionRule,
    fields: Record<string, FieldResolver>,
    payload: AutomationEventPayload,
  ): boolean {
    const resolver = fields[rule.field];
    // Unknown field — refuse. Better to fail closed than fire incorrectly.
    if (!resolver) {
      this.logger.warn(
        `Unknown condition field "${rule.field}" — rule fails closed`,
      );
      return false;
    }
    const actual = resolver(payload);
    return this.applyOperator(rule.op, actual, rule.value);
  }

  private applyOperator(
    op: ConditionOperator,
    actual: unknown,
    expected: ConditionRule['value'],
  ): boolean {
    switch (op) {
      case 'equals':
        return actual === expected;
      case 'not_equals':
        return actual !== expected;
      case 'contains': {
        if (typeof actual !== 'string' || typeof expected !== 'string') {
          return false;
        }
        return actual.toLowerCase().includes(expected.toLowerCase());
      }
      case 'not_contains': {
        if (typeof actual !== 'string') return true;
        if (typeof expected !== 'string') return true;
        return !actual.toLowerCase().includes(expected.toLowerCase());
      }
      case 'in': {
        if (!Array.isArray(expected)) return false;
        return (expected as Array<unknown>).includes(actual);
      }
      case 'not_in': {
        if (!Array.isArray(expected)) return true;
        return !(expected as Array<unknown>).includes(actual);
      }
      case 'is_set':
        return actual !== null && actual !== undefined && actual !== '';
      case 'is_not_set':
        return actual === null || actual === undefined || actual === '';
    }
  }

  private isRoot(value: unknown): value is ConditionRoot {
    if (!value || typeof value !== 'object') return false;
    const v = value as ConditionRoot;
    return (
      (v.match === 'AND' || v.match === 'OR') &&
      Array.isArray(v.groups)
    );
  }
}
