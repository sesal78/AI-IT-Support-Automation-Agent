"use client";

import { useRouter } from "next/navigation";
import { CATEGORIES, PRIORITIES } from "@ai-it-support/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STATUS_FILTER_VALUES, type StatusFilterValue } from "@/lib/staff/ticket-list-filters";

const ALL = "all";

const STATUS_LABELS: Record<StatusFilterValue, string> = {
  new: "New",
  in_progress: "In progress",
  on_hold: "On hold",
  resolved: "Resolved",
  closed: "Closed",
  review_pending: "Awaiting review",
  manual: "Manual queue",
};

export interface TicketFiltersProps {
  status: string | null;
  priority: string | null;
  category: string | null;
}

/**
 * The filter bar (P5-T17): shadcn `Select` controls that change the URL
 * query, so filtering is server-rendered on the next request. A filter
 * change resets to page 1 (no `page` param is ever carried over here).
 */
export function TicketFilters({ status, priority, category }: TicketFiltersProps) {
  const router = useRouter();

  function update(name: "status" | "priority" | "category", value: string) {
    const next = { status, priority, category, [name]: value };
    const params = new URLSearchParams();
    for (const [key, val] of Object.entries(next)) {
      if (val && val !== ALL) params.set(key, val);
    }
    const query = params.toString();
    router.push(query ? `/staff/tickets?${query}` : "/staff/tickets");
  }

  return (
    <div className="flex flex-wrap gap-3">
      <Select value={status ?? ALL} onValueChange={(value) => update("status", value)}>
        <SelectTrigger className="w-44" aria-label="Status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {STATUS_FILTER_VALUES.map((value) => (
            <SelectItem key={value} value={value}>
              {STATUS_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={priority ?? ALL} onValueChange={(value) => update("priority", value)}>
        <SelectTrigger className="w-32" aria-label="Priority">
          <SelectValue placeholder="Priority" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All priorities</SelectItem>
          {PRIORITIES.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={category ?? ALL} onValueChange={(value) => update("category", value)}>
        <SelectTrigger className="w-40" aria-label="Category">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All categories</SelectItem>
          {CATEGORIES.map((value) => (
            <SelectItem key={value} value={value}>
              {value.replace(/_/g, " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
