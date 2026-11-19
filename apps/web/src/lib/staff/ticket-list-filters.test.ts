import { describe, expect, it } from "vitest";
import { buildTicketListHref, parseTicketListQuery } from "./ticket-list-filters";

describe("parseTicketListQuery", () => {
  it("defaults to the unfiltered, test-ticket-hidden, page 1 list", () => {
    const { filters, invalid } = parseTicketListQuery({}, { e2eMode: false });
    expect(filters).toEqual({
      status: null,
      priority: null,
      category: null,
      showTestTickets: false,
      page: 1,
    });
    expect(invalid).toBe(false);
  });

  it("shows test tickets only when E2E_MODE is true, with no query param for it", () => {
    expect(
      parseTicketListQuery({ is_test: "true" }, { e2eMode: false }).filters.showTestTickets,
    ).toBe(false);
    expect(parseTicketListQuery({}, { e2eMode: true }).filters.showTestTickets).toBe(true);
  });

  it.each([
    ["new", "P1", "hardware"],
    ["review_pending", "P4", "network"],
    ["manual", "P2", "inquiry"],
  ])(
    "accepts the combination status=%s, priority=%s, category=%s",
    (status, priority, category) => {
      const { filters, invalid } = parseTicketListQuery(
        { status, priority, category },
        { e2eMode: false },
      );
      expect(filters).toMatchObject({ status, priority, category });
      expect(invalid).toBe(false);
    },
  );

  it.each(["new", "in_progress", "on_hold", "resolved", "closed", "review_pending", "manual"])(
    "accepts the status value %s",
    (status) => {
      const { filters, invalid } = parseTicketListQuery({ status }, { e2eMode: false });
      expect(filters.status).toBe(status);
      expect(invalid).toBe(false);
    },
  );

  it("falls back to the unfiltered first page and keeps test tickets hidden", () => {
    const { filters, invalid } = parseTicketListQuery(
      { status: "deleted", priority: "P1", category: "hardware", page: "3" },
      { e2eMode: false },
    );
    expect(filters).toEqual({
      status: null,
      priority: null,
      category: null,
      page: 1,
      showTestTickets: false,
    });
    expect(invalid).toBe(true);
  });

  it("drops an unknown priority", () => {
    const { filters, invalid } = parseTicketListQuery({ priority: "P0" }, { e2eMode: false });
    expect(filters.priority).toBeNull();
    expect(invalid).toBe(true);
  });

  it("drops an unknown category", () => {
    const { filters, invalid } = parseTicketListQuery({ category: "legal" }, { e2eMode: false });
    expect(filters.category).toBeNull();
    expect(invalid).toBe(true);
  });

  it("takes the first value of a repeated query param", () => {
    const { filters, invalid } = parseTicketListQuery(
      { status: ["new", "closed"] },
      { e2eMode: false },
    );
    expect(filters.status).toBe("new");
    expect(invalid).toBe(false);
  });

  it.each(["0", "-1", "1.5", "01", "abc", ""])("falls back to page 1 for page=%j", (page) => {
    const { filters, invalid } = parseTicketListQuery({ page }, { e2eMode: false });
    expect(filters.page).toBe(1);
    // An empty value is "not supplied", not an invalid one.
    expect(invalid).toBe(page !== "");
  });

  it("accepts a valid page number", () => {
    const { filters, invalid } = parseTicketListQuery({ page: "3" }, { e2eMode: false });
    expect(filters.page).toBe(3);
    expect(invalid).toBe(false);
  });

  it("treats an empty string filter value as not supplied", () => {
    const { filters, invalid } = parseTicketListQuery({ status: "" }, { e2eMode: false });
    expect(filters.status).toBeNull();
    expect(invalid).toBe(false);
  });
});

describe("buildTicketListHref", () => {
  const baseFilters = {
    status: null,
    priority: null,
    category: null,
    showTestTickets: false,
    page: 1,
  };

  it("omits page when it is 1 and keeps no empty query string", () => {
    expect(buildTicketListHref(baseFilters, 1)).toBe("/staff/tickets");
  });

  it("carries the current filters and the requested page", () => {
    const href = buildTicketListHref(
      { ...baseFilters, status: "new", priority: "P1", category: "network" },
      2,
    );
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/staff/tickets");
    expect(url.searchParams.get("status")).toBe("new");
    expect(url.searchParams.get("priority")).toBe("P1");
    expect(url.searchParams.get("category")).toBe("network");
    expect(url.searchParams.get("page")).toBe("2");
  });
});
