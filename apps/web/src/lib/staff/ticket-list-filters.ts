import { z } from "zod";
import {
  CATEGORIES,
  HELPDESK_STATES,
  PRIORITIES,
  type Category,
  type Priority,
} from "@ai-it-support/shared";

/**
 * The combined `status` filter (plan §6.3.1 P5-T17): the 5 helpdesk states,
 * plus `review_pending` (still waiting on a human) and `manual` (a human sent
 * it to the manual queue: ticket status `rejected` or `escalated_manual`).
 */
export const STATUS_FILTER_VALUES = [...HELPDESK_STATES, "review_pending", "manual"] as const;
export type StatusFilterValue = (typeof STATUS_FILTER_VALUES)[number];

export const TICKET_LIST_PAGE_SIZE = 50;

export interface TicketListFilters {
  status: StatusFilterValue | null;
  priority: Priority | null;
  category: Category | null;
  /** Test tickets show only in E2E_MODE (plan §6.1 DoD 6); no query param controls this. */
  showTestTickets: boolean;
  page: number;
}

export interface TicketListQuery {
  filters: TicketListFilters;
  /** True when the list falls back to the unfiltered first page. */
  invalid: boolean;
}

type RawSearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const statusSchema = z.enum(STATUS_FILTER_VALUES);
const prioritySchema = z.enum(PRIORITIES);
const categorySchema = z.enum(CATEGORIES);
// A plain positive integer with no sign, decimal or leading zero ("1", "2", …
// never "1.5", "01" or "+1"); z.coerce would accept those too, so the shape
// is checked on the string first.
const pageSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform((value) => Number.parseInt(value, 10))
  .refine(Number.isSafeInteger);

function readEnum<T extends string>(
  schema: z.ZodType<T>,
  raw: string | string[] | undefined,
  issues: string[],
  name: string,
): T | null {
  const value = first(raw);
  if (value === undefined || value === "") return null;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  issues.push(name);
  return null;
}

function readPage(raw: string | string[] | undefined, issues: string[]): number {
  const value = first(raw);
  if (value === undefined || value === "") return 1;
  const result = pageSchema.safeParse(value);
  if (result.success) return result.data;
  issues.push("page");
  return 1;
}

/**
 * Invalid search values reset the list to page 1. Test-ticket visibility
 * always comes from E2E_MODE.
 */
export function parseTicketListQuery(
  searchParams: RawSearchParams,
  options: { e2eMode: boolean },
): TicketListQuery {
  const issues: string[] = [];
  const status = readEnum(statusSchema, searchParams.status, issues, "status");
  const priority = readEnum(prioritySchema, searchParams.priority, issues, "priority");
  const category = readEnum(categorySchema, searchParams.category, issues, "category");
  const page = readPage(searchParams.page, issues);

  const showTestTickets = options.e2eMode;
  if (issues.length > 0) {
    return {
      filters: { status: null, priority: null, category: null, showTestTickets, page: 1 },
      invalid: true,
    };
  }
  return { filters: { status, priority, category, showTestTickets, page }, invalid: false };
}

/** Builds a `/staff/tickets` href for `page`, keeping the current filters. */
export function buildTicketListHref(filters: TicketListFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.category) params.set("category", filters.category);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/staff/tickets?${query}` : "/staff/tickets";
}
