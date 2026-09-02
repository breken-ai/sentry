import * as Sentry from '@sentry/react';
import keyBy from 'lodash/keyBy';

import {getContextMeta} from 'sentry/components/events/contexts/utils';
import type {
  RawSpanType,
  TraceContextSpanProxy,
} from 'sentry/components/events/interfaces/spans/types';
import {
  EntryType,
  type EntrySpans,
  type Event,
  type EventTransaction,
} from 'sentry/types/event';
import {getIssueTypeFromOccurrenceType, IssueType} from 'sentry/types/group';

export const TRACE_WATERFALL_PREFERENCES_KEY =
  'issue-details-trace-waterfall-preferences';

/**
 * Trace IDs are required for EAP occurrences, but some events will not have a trace (e.g. metric issues).
 * Relay will synthesize a `trace_id` in this case and flags the field with a `trace_id.missing` remark in `_meta`.
 */
export function eventHasSyntheticTrace(event: Event): boolean {
  const traceMeta = getContextMeta(event, 'trace');
  return (traceMeta.trace_id?.['']?.err ?? []).some(
    (err: unknown) => (Array.isArray(err) ? err[0] : err) === 'trace_id.missing'
  );
}

/**
 * Get Relay's span group value, which EAP indexes as `span.group`. Use this - and only this - when
 * the value gets handed back to Explore or Insights as a query filter, since anything else won't
 * match what's stored there. To compare spans against each other within a single view, use
 * `getSpanHash`, which is allowed to fall back to the server-calculated `hash` value (which EAP
 * doesn't know about, but which always exists, unlike this value, which is only computed for spans
 * with descriptions and certain `op` values).
 */
export function getSpanSentryGroupValue(span: {
  [key: string]: any;
  data?: Record<string, any> | null;
  sentry_tags?: Record<string, string>;
}): string | undefined {
  return (
    // The location for segment-derived occurrences
    span.data?.['sentry.group'] ??
    // The location for transaction-derived occurrences
    // TODO: once we fully switch to segment-based occurrence creation, and all transaction events
    // have aged out, we can remove this half of expression
    span.sentry_tags?.group
  );
}

/**
 * Get a value identifying which spans are the same operation, used for visually grouping spans in
 * the span evidence section of the issue details page and for explaining occurrence grouping in the
 * grouping info section. Not interchangeable with `getSpanSentryGroupValue` - this can return our
 * own span grouping hash, which EAP has never seen, so it must not be used to build a query filter.
 *
 * Prefers Relay's `sentry.group` value, but falls back to the hash our own span grouping computes
 * in cases where Relay hasn't assigned a `sentry.group` value (because the span is missing a
 * description or has an op Relay ignores).
 */
export function getSpanHash(span: {
  [key: string]: any;
  data?: Record<string, any> | null;
  hash?: string;
  sentry_tags?: Record<string, string>;
}): string | undefined {
  // TODO: once we fully switch to segment-based occurrence creation, and all transaction events
  // have aged out, this whole thing can become just
  // `span.data?.["sentry.group"] ?? span.data?.hash`
  return (
    getSpanSentryGroupValue(span) ??
    // The location for segment-derived occurrences
    span.data?.hash ??
    // The location for transaction-derived occurrences
    span.hash
  );
}

/**
 * Get the span category, used to build the span summary link. Like the span hash, where it lives
 * depends on which pipeline (transaction or segment processing) created the evidence span.
 */
export function getSpanCategory(span: {
  [key: string]: any;
  data?: Record<string, any> | null;
  sentry_tags?: Record<string, string>;
}): string | undefined {
  return (
    // The location for segment-derived occurrences
    span.data?.['sentry.category'] ??
    // The location for transaction-derived occurrences
    span.sentry_tags?.category
  );
}

export function getSpanInfoFromTransactionEvent(
  event: Pick<
    EventTransaction,
    | 'entries'
    | 'perfProblem'
    | 'issueCategory'
    | 'endTimestamp'
    | 'contexts'
    | 'occurrence'
  >
) {
  const perfEvidenceData = event.perfProblem ?? event?.occurrence?.evidenceData;
  if (!perfEvidenceData) {
    Sentry.captureException(new Error('Span Evidence missing for performance issue.'));
    return null;
  }

  // Let's dive into the event to pick off the span evidence data by using the IDs we know
  const spanEntry = event.entries.find((entry: EntrySpans | any): entry is EntrySpans => {
    return entry.type === EntryType.SPANS;
  });

  const spans: Array<RawSpanType | TraceContextSpanProxy> = spanEntry?.data
    ? [...spanEntry.data]
    : [];

  if (event?.contexts?.trace?.span_id) {
    // TODO: Fix this conditional and check if span_id is ever actually undefined.
    spans.push(event.contexts.trace as TraceContextSpanProxy);
  }
  const spansById = keyBy(spans, 'span_id');
  const parentSpanIDs = perfEvidenceData?.parentSpanIds ?? [];
  const offendingSpanIDs = perfEvidenceData?.offenderSpanIds ?? [];
  const causeSpanIDs = perfEvidenceData?.causeSpanIds ?? [];
  return {
    parentSpan: spansById[parentSpanIDs[0]],
    offendingSpans: offendingSpanIDs.map((spanID: any) => spansById[spanID]),
    causeSpans: causeSpanIDs.map((spanID: any) => spansById[spanID]),
  };
}

/**
 * Given an event for a performance issue, returns the `affectedSpanIds` and `focusedSpanIds`.
 * Both of these subsets of spans are used to determine which spans are initially visible on the span tree on the issue details
 * page. The main difference is that the former will be highlighted in red, these spans are intended to indicate the 'root cause' spans
 * of the issue, with the latter being supplemental spans that are involved in the issue but not necessarily the cause of it.
 *
 * @param event
 */
export function getProblemSpansForSpanTree(event: EventTransaction): {
  affectedSpanIds: string[];
  focusedSpanIds: string[];
} {
  const perfEvidenceData = event.perfProblem ?? event?.occurrence?.evidenceData;

  const issueType =
    event.perfProblem?.issueType ??
    getIssueTypeFromOccurrenceType(event?.occurrence?.type);
  const affectedSpanIds: string[] = [];
  const focusedSpanIds: string[] = [];

  // By default, offender spans will always be `affected spans`
  const offenderSpanIds = perfEvidenceData?.offenderSpanIds ?? [];
  affectedSpanIds.push(...offenderSpanIds);

  if (issueType !== IssueType.PERFORMANCE_N_PLUS_ONE_API_CALLS) {
    const parentSpanIds = perfEvidenceData?.parentSpanIds ?? [];
    affectedSpanIds.push(...parentSpanIds);
  }

  if (issueType === IssueType.PERFORMANCE_CONSECUTIVE_DB_QUERIES) {
    const consecutiveSpanIds = perfEvidenceData?.causeSpanIds ?? [];

    if (consecutiveSpanIds.length < 11) {
      focusedSpanIds.push(...consecutiveSpanIds);
    }
  }

  if (issueType === IssueType.PERFORMANCE_N_PLUS_ONE_DB_QUERIES) {
    const precedingSpans = perfEvidenceData?.causeSpanIds ?? [];
    focusedSpanIds.push(...precedingSpans);
  }

  return {affectedSpanIds, focusedSpanIds};
}

export const isWebVitalsEvent = (event: Event) => {
  return getIssueTypeFromOccurrenceType(event.occurrence?.type) === IssueType.WEB_VITALS; // Web Vitals group type id
};
