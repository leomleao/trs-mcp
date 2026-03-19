import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { addTimeEntriesViaUi } from "./trs-ui-automation.js";
import { autoLearnAlias, listTicketMappings, resolveBookingSelection, upsertCustomTicketAlias } from "./trs-ticket-mappings.js";

const TRS_BASE_URL = process.env.TRS_BASE_URL ?? "https://portal.theconfigteam.co.uk/api";
const TRS_USER_AGENT = "trs-mcp-server/1.0";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface AuthContext {
  userId?: string;
  token?: string;
}

interface TrsComment {
  author: string;
  created_at: string;
  text: string;
}

interface TrsTicket {
  ticket_id: string;
  title: string;
  status: string;
  assignee: string | null;
  customer: string;
  description?: string;
  comments?: TrsComment[];
}

interface TimesheetEntryInput {
  ticket_id: string;
  date: string;
  hours: number;
  description: string;
  booking_mode?: "favourite" | "search";
}

interface ResolvedTimesheetEntry extends TimesheetEntryInput {
  resolved_booking: {
    ticket_code: string;
    booking_mode: "favourite" | "search";
    title: string | null;
    confidence: "high" | "medium" | "low";
    matched_alias: string | null;
    source: "explicit_ticket" | "seed_mapping" | "custom_alias";
  } | null;
}

interface TimesheetEntryResult {
  ticket_id: string;
  date: string;
  hours: number;
  success: boolean;
  entry_id?: string;
  error?: string;
}

interface TrsApiErrorBody {
  message?: string;
  error?: string;
}

class TrsApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly context?: Record<string, string>,
  ) {
    super(message);
    this.name = "TrsApiError";
  }
}

class TrsHttpClient {
  constructor(private readonly baseUrl: string) {}

  async get<T>(path: string, authContext: AuthContext, query?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, authContext, undefined, query);
  }

  async post<T>(
    path: string,
    authContext: AuthContext,
    body?: Record<string, JsonValue> | JsonValue[],
  ): Promise<T> {
    return this.request<T>("POST", path, authContext, body);
  }

  async patch<T>(path: string, authContext: AuthContext, body?: Record<string, JsonValue>): Promise<T> {
    return this.request<T>("PATCH", path, authContext, body);
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    authContext: AuthContext,
    body?: Record<string, JsonValue> | JsonValue[],
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": TRS_USER_AGENT,
    };

    if (authContext.token) {
      headers.Authorization = `Bearer ${authContext.token}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorDetail = `${response.status} ${response.statusText}`;

      try {
        const errorJson = (await response.json()) as TrsApiErrorBody;
        errorDetail = errorJson.message ?? errorJson.error ?? errorDetail;
      } catch {
        // Ignore JSON parse failures and fall back to status text.
      }

      throw new TrsApiError(`TRS API request failed: ${errorDetail}`, response.status, {
        method,
        path,
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

const trsClient = new TrsHttpClient(TRS_BASE_URL);

function shouldUseUiAutomation(authContext: AuthContext): boolean {
  return (
    process.env.TRS_USE_UI_AUTOMATION === "1" ||
    process.env.TRS_ALWAYS_USE_UI === "1" ||
    !authContext.token
  );
}

function resolveAuthContext(): AuthContext {
  return {
    // TODO: support request-scoped user auth injected by the MCP host, if available.
    userId: process.env.TRS_USER_ID,
    token: process.env.TRS_API_TOKEN,
  };
}

function requireCurrentUserId(authContext: AuthContext): string {
  if (!authContext.userId) {
    throw new TrsApiError(
      "No TRS user context is configured. Set TRS_USER_ID or wire request-scoped identity into resolveAuthContext().",
    );
  }

  return authContext.userId;
}

function requireApiAuth(authContext: AuthContext, toolName: string): void {
  if (!authContext.token) {
    throw new TrsApiError(
      `${toolName} currently requires a real TRS API token and endpoint mapping. UI automation is only wired for add_timesheet_entries_for_week right now.`,
    );
  }
}

function deriveTicketTitle(description: string): string {
  const firstSentence = description.replace(/\s+/g, " ").trim().split(/[.!?]/)[0]?.trim() ?? "New TRS ticket";
  return firstSentence.slice(0, 80) || "New TRS ticket";
}

function summariseComments(comments: TrsComment[]): string {
  if (comments.length === 0) {
    return "No comments are recorded on this ticket yet.";
  }

  const sorted = [...comments].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const latest = sorted[sorted.length - 1];
  const authors = [...new Set(sorted.map((comment) => comment.author))];
  const opening = sorted[0]?.text.trim();
  const closing = latest?.text.trim();

  const sentences = [
    `There are ${comments.length} comment${comments.length === 1 ? "" : "s"} from ${authors.join(", ")}.`,
    opening ? `The discussion started with: "${truncate(opening, 120)}".` : undefined,
    closing ? `The latest update says: "${truncate(closing, 120)}".` : undefined,
    "Overall, the thread suggests the ticket is actively being worked and should be reviewed for the next action.",
  ].filter((sentence): sentence is string => Boolean(sentence));

  return sentences.slice(0, 4).join(" ");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function resolveTimesheetEntries(entries: TimesheetEntryInput[]): Promise<ResolvedTimesheetEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const resolution = await resolveBookingSelection(entry.ticket_id, entry.description);
      return {
        ...entry,
        ticket_id: resolution?.ticketCode ?? entry.ticket_id,
        booking_mode: resolution?.mode ?? entry.booking_mode,
        resolved_booking: resolution
          ? {
              ticket_code: resolution.ticketCode,
              booking_mode: resolution.mode,
              title: resolution.title ?? null,
              confidence: resolution.confidence,
              matched_alias: resolution.matchedAlias ?? null,
              source: resolution.source,
            }
          : null,
      };
    }),
  );
}

async function trsGetTicket(ticketId: string, authContext: AuthContext): Promise<TrsTicket> {
  type GetTicketResponse = {
    id: string;
    title: string;
    status: string;
    assignee?: { username?: string | null };
    customer?: { name?: string | null };
    description?: string;
    comments?: Array<{
      author?: { username?: string | null };
      created_at?: string;
      text?: string;
    }>;
  };

  requireApiAuth(authContext, "get_ticket_and_summarise_comments");

  // TODO: replace this placeholder endpoint and response mapping with the real TRS ticket details API.
  const response = await trsClient.get<GetTicketResponse>(`tickets/${ticketId}`, authContext);

  return {
    ticket_id: response.id,
    title: response.title,
    status: response.status,
    assignee: response.assignee?.username ?? null,
    customer: response.customer?.name ?? "Unknown customer",
    description: response.description,
    comments: (response.comments ?? []).map((comment) => ({
      author: comment.author?.username ?? "unknown",
      created_at: comment.created_at ?? new Date(0).toISOString(),
      text: comment.text ?? "",
    })),
  };
}

async function trsListTicketsForUser(
  userId: string,
  startDate: string,
  endDate: string,
  authContext: AuthContext,
): Promise<TrsTicket[]> {
  type ListTicketsResponse = {
    tickets: Array<{
      id: string;
      title: string;
      status: string;
      description?: string;
      customer?: { name?: string | null };
      assignee?: { username?: string | null };
    }>;
  };

  requireApiAuth(authContext, "list_my_tickets_for_week");

  // TODO: replace this placeholder endpoint and query keys with the real TRS assignee/date-range ticket listing API.
  const response = await trsClient.get<ListTicketsResponse>("tickets", authContext, {
    assignee: userId,
    start_date: startDate,
    end_date: endDate,
  });

  return response.tickets.map((ticket) => ({
    ticket_id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    assignee: ticket.assignee?.username ?? userId,
    customer: ticket.customer?.name ?? "Unknown customer",
    description: ticket.description,
  }));
}

async function trsAddTimesheetEntries(
  userId: string,
  entries: TimesheetEntryInput[],
  authContext: AuthContext,
): Promise<{ success: boolean; results: TimesheetEntryResult[] }> {
  const useUiAutomation = shouldUseUiAutomation(authContext);

  if (useUiAutomation) {
    const uiResult = await addTimeEntriesViaUi(
      entries.map((entry) => ({
        ticketId: entry.ticket_id,
        date: entry.date,
        hours: entry.hours,
        description: entry.description,
      })),
      {
        baseUrl: TRS_BASE_URL.replace(/\/api\/?$/, ""),
        keepOpen: false,
      },
    );

    return {
      success: uiResult.success,
      results: uiResult.results.map((r) => ({
        ticket_id: r.entry.ticketId,
        date: r.entry.date,
        hours: r.entry.hours,
        success: r.success,
        error: r.error,
      })),
    };
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<TimesheetEntryResult> => {
      try {
        type CreateTimesheetResponse = {
          id: string;
        };

        // TODO: replace this placeholder endpoint and payload shape with the real TRS or timesheet API.
        const response = await trsClient.post<CreateTimesheetResponse>("timesheets/entries", authContext, {
          user_id: userId,
          ticket_id: entry.ticket_id,
          work_date: entry.date,
          hours: entry.hours,
          description: entry.description,
        });

        return {
          ticket_id: entry.ticket_id,
          date: entry.date,
          hours: entry.hours,
          success: true,
          entry_id: response.id,
        };
      } catch (error) {
        console.error("Failed to add TRS timesheet entry", {
          ticketId: entry.ticket_id,
          date: entry.date,
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          ticket_id: entry.ticket_id,
          date: entry.date,
          hours: entry.hours,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }),
  );

  return {
    success: results.every((result) => result.success),
    results,
  };
}

async function trsUpdateTicketStatus(
  ticketId: string,
  newStatus: string,
  authContext: AuthContext,
): Promise<void> {
  requireApiAuth(authContext, "update_ticket_status_with_comment");

  // TODO: replace this placeholder endpoint and payload with the real TRS ticket status update API.
  await trsClient.patch<void>(`tickets/${ticketId}`, authContext, {
    status: newStatus,
  });
}

async function trsAddTicketComment(
  ticketId: string,
  comment: string,
  authContext: AuthContext,
): Promise<TrsComment> {
  type AddCommentResponse = {
    author?: { username?: string | null };
    created_at?: string;
    text?: string;
  };

  requireApiAuth(authContext, "update_ticket_status_with_comment");

  // TODO: replace this placeholder endpoint and payload with the real TRS add-comment API.
  const response = await trsClient.post<AddCommentResponse>(`tickets/${ticketId}/comments`, authContext, {
    text: comment,
  });

  return {
    author: response.author?.username ?? authContext.userId ?? "current-user",
    created_at: response.created_at ?? new Date().toISOString(),
    text: response.text ?? comment,
  };
}

async function trsCreateTicket(
  customerName: string,
  description: string,
  title: string,
  authContext: AuthContext,
): Promise<TrsTicket> {
  type CreateTicketResponse = {
    id: string;
    title: string;
    status: string;
    description?: string;
    customer?: { name?: string | null };
    assignee?: { username?: string | null };
  };

  requireApiAuth(authContext, "create_ticket_for_customer");

  // TODO: replace this placeholder endpoint and payload shape with the real TRS create-ticket API.
  const response = await trsClient.post<CreateTicketResponse>("tickets", authContext, {
    title,
    description,
    customer_name: customerName,
  });

  return {
    ticket_id: response.id,
    title: response.title,
    status: response.status,
    assignee: response.assignee?.username ?? null,
    customer: response.customer?.name ?? customerName,
    description: response.description ?? description,
    comments: [],
  };
}

function formatToolResult<T extends Record<string, unknown>>(data: T, summary: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: summary,
      },
    ],
    structuredContent: data,
  };
}

function formatToolError(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({
  name: "trs-ticketing",
  version: "1.0.0",
});

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date in YYYY-MM-DD format.");

server.registerTool(
  "get_ticket_and_summarise_comments",
  {
    title: "Get Ticket And Summarise Comments",
    description:
      "Fetch a TRS ticket by ID, including status, assignee, customer, and comments, then return both the raw ticket data and a concise natural-language summary of the comment history.",
    inputSchema: {
      ticket_id: z.string().min(1).describe("The TRS ticket identifier to fetch."),
    },
  },
  async ({ ticket_id }) => {
    try {
      const authContext = resolveAuthContext();
      const ticket = await trsGetTicket(ticket_id, authContext);
      const result = {
        ticket_id: ticket.ticket_id,
        title: ticket.title,
        status: ticket.status,
        assignee: ticket.assignee,
        customer: ticket.customer,
        description: ticket.description ?? null,
        comments: ticket.comments ?? [],
        comments_summary: summariseComments(ticket.comments ?? []),
      };

      return formatToolResult(
        result,
        `Fetched TRS ticket ${ticket.ticket_id} for ${ticket.customer}. Current status: ${ticket.status}. ${result.comments_summary}`,
      );
    } catch (error) {
      console.error("Failed to fetch TRS ticket", {
        ticketId: ticket_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return formatToolError(error instanceof Error ? error.message : "Failed to fetch TRS ticket.");
    }
  },
);

server.registerTool(
  "list_my_tickets_for_week",
  {
    title: "List My Tickets For Week",
    description:
      "List TRS tickets assigned to the current user within an ISO date range, which is useful for week-based planning or progress checks.",
    inputSchema: {
      start_date: isoDateSchema.describe("Inclusive start date in YYYY-MM-DD format."),
      end_date: isoDateSchema.describe("Inclusive end date in YYYY-MM-DD format."),
    },
  },
  async ({ start_date, end_date }) => {
    try {
      const authContext = resolveAuthContext();
      const userId = requireCurrentUserId(authContext);
      const tickets = await trsListTicketsForUser(userId, start_date, end_date, authContext);
      const result = {
        user_id: userId,
        start_date,
        end_date,
        tickets: tickets.map((ticket) => ({
          ticket_id: ticket.ticket_id,
          title: ticket.title,
          status: ticket.status,
          customer: ticket.customer,
          description: ticket.description ?? null,
        })),
      };

      return formatToolResult(
        result,
        `Found ${result.tickets.length} ticket${result.tickets.length === 1 ? "" : "s"} assigned to ${userId} between ${start_date} and ${end_date}.`,
      );
    } catch (error) {
      console.error("Failed to list TRS tickets for current user", {
        startDate: start_date,
        endDate: end_date,
        error: error instanceof Error ? error.message : String(error),
      });
      return formatToolError(error instanceof Error ? error.message : "Failed to list TRS tickets.");
    }
  },
);

server.registerTool(
  "list_time_booking_mappings",
  {
    title: "List Time Booking Mappings",
    description:
      "List the seeded AMS time-booking mappings and any custom aliases that have been added for natural-language timesheet booking.",
    inputSchema: {},
  },
  async () => {
    try {
      const mappings = await listTicketMappings();
      return formatToolResult(
        {
          seed_mappings: mappings.seeds.map((mapping) => ({
            title: mapping.title,
            ticket_code: mapping.ticketCode,
            booking_mode: mapping.bookingMode,
            aliases: mapping.aliases,
            type_of_time: mapping.typeOfTime ?? null,
          })),
          custom_aliases: mappings.customAliases.map((alias) => ({
            alias: alias.alias,
            ticket_code: alias.ticketCode,
            booking_mode: alias.bookingMode,
            title: alias.title ?? null,
            notes: alias.notes ?? null,
          })),
        },
        `Loaded ${mappings.seeds.length} seeded time-booking mappings and ${mappings.customAliases.length} custom aliases.`,
      );
    } catch (error) {
      return formatToolError(error instanceof Error ? error.message : "Failed to list time booking mappings.");
    }
  },
);

server.registerTool(
  "upsert_time_booking_alias",
  {
    title: "Upsert Time Booking Alias",
    description:
      "Create or update a custom natural-language alias for TRS time booking so future timesheet entries can resolve phrases like 'inbox and management' automatically.",
    inputSchema: {
      alias: z.string().min(1).describe("The natural-language phrase to map, such as 'inbox and management'."),
      ticket_code: z.string().min(1).describe("The TRS ticket code to resolve to, such as TCTTCT-5687."),
      booking_mode: z
        .enum(["favourite", "search"])
        .default("favourite")
        .describe("How this booking should be selected in the TRS Add Time modal."),
      title: z.string().min(1).optional().describe("Optional human-readable title for the target booking code."),
      notes: z.string().min(1).optional().describe("Optional notes explaining when this alias should be used."),
    },
  },
  async ({ alias, ticket_code, booking_mode, title, notes }) => {
    try {
      const saved = await upsertCustomTicketAlias({
        alias,
        ticketCode: ticket_code,
        bookingMode: booking_mode,
        title,
        notes,
      });

      return formatToolResult(
        {
          alias: saved.alias,
          ticket_code: saved.ticketCode,
          booking_mode: saved.bookingMode,
          title: saved.title ?? null,
          notes: saved.notes ?? null,
        },
        `Saved the custom alias '${saved.alias}' for ${saved.ticketCode}.`,
      );
    } catch (error) {
      return formatToolError(error instanceof Error ? error.message : "Failed to save time booking alias.");
    }
  },
);

server.registerTool(
  "add_timesheet_entries_for_week",
  {
    title: "Add Timesheet Entries For Week",
    description:
      "Create one or more TRS timesheet entries for the current user. You can provide a direct ticket code or rely on the description and saved alias mappings for natural-language booking. The tool returns per-entry success and failure details so partial completion can be handled safely.",
    inputSchema: {
      entries: z
        .array(
          z.object({
            ticket_id: z
              .string()
              .default("")
              .describe("Optional ticket code to book time against. Leave blank when the description should resolve via the alias map."),
            date: isoDateSchema.describe("The work date in YYYY-MM-DD format."),
            hours: z.number().positive().describe("Hours worked on that date."),
            description: z.string().min(1).describe("Short description of the work performed."),
          }),
        )
        .min(1)
        .describe("One or more timesheet entries to create."),
    },
  },
  async ({ entries }) => {
    try {
      const authContext = resolveAuthContext();
      const userId = shouldUseUiAutomation(authContext)
        ? authContext.userId ?? "ui-session"
        : requireCurrentUserId(authContext);
      const resolvedEntries = await resolveTimesheetEntries(entries);
      const result = await trsAddTimesheetEntries(
        userId,
        resolvedEntries.map((entry) => ({
        ticket_id: entry.ticket_id,
        date: entry.date,
        hours: entry.hours,
        description: entry.description,
        booking_mode: entry.booking_mode,
      })),
      authContext,
    );

      return formatToolResult(
        {
          user_id: userId,
          success: result.success,
          resolved_entries: resolvedEntries.map((entry) => ({
            ticket_id: entry.ticket_id,
            date: entry.date,
            description: entry.description,
            resolved_booking: entry.resolved_booking,
          })),
          results: result.results,
        },
        result.success
          ? `Created ${result.results.length} timesheet entr${result.results.length === 1 ? "y" : "ies"} for ${userId}.`
          : `Processed ${result.results.length} timesheet entries for ${userId} with some failures. Check the per-entry results for details.`,
      );
    } catch (error) {
      console.error("Failed to add TRS timesheet entries", {
        error: error instanceof Error ? error.message : String(error),
      });
      return formatToolError(error instanceof Error ? error.message : "Failed to add TRS timesheet entries.");
    }
  },
);

server.registerTool(
  "book_time_from_activity",
  {
    title: "Book Time From Activity",
    description:
      "Book a single TRS timesheet entry from a natural-language activity description such as 'inbox and ticket management'. The server resolves the booking code automatically using the seeded and custom alias mappings.",
    inputSchema: {
      activity: z
        .string()
        .min(1)
        .describe("Natural-language activity to book time against, such as 'inbox and ticket management'."),
      hours: z.number().positive().describe("Number of hours to book."),
      date: isoDateSchema
        .optional()
        .describe("Optional work date in YYYY-MM-DD format. Defaults to today's date if omitted."),
      comment: z
        .string()
        .optional()
        .describe("Optional comment to store in TRS. Defaults to the activity text when omitted."),
      ticket_id: z
        .string()
        .optional()
        .describe("Optional explicit ticket code. Leave blank to let the alias resolver choose automatically."),
      auto_learn_alias: z
        .boolean()
        .default(true)
        .describe("When true, a successful booking can save the activity phrase as a reusable custom alias if it is not already known."),
    },
  },
  async ({ activity, hours, date, comment, ticket_id, auto_learn_alias }) => {
    try {
      const authContext = resolveAuthContext();
      const userId = shouldUseUiAutomation(authContext)
        ? authContext.userId ?? "ui-session"
        : requireCurrentUserId(authContext);
      const entryDate = date ?? todayIsoDate();
      const entryDescription = comment?.trim() || activity;
      const resolvedEntries = await resolveTimesheetEntries([
        {
          ticket_id: ticket_id?.trim() ?? "",
          date: entryDate,
          hours,
          description: entryDescription,
        },
      ]);

      const result = await trsAddTimesheetEntries(
        userId,
        resolvedEntries.map((entry) => ({
          ticket_id: entry.ticket_id,
          date: entry.date,
          hours: entry.hours,
          description: entry.description,
          booking_mode: entry.booking_mode,
        })),
        authContext,
      );
      const learnedAlias =
        result.success && auto_learn_alias && resolvedEntries[0].resolved_booking
          ? await autoLearnAlias(activity, {
              mode: resolvedEntries[0].resolved_booking.booking_mode,
              ticketCode: resolvedEntries[0].resolved_booking.ticket_code,
              title: resolvedEntries[0].resolved_booking.title ?? undefined,
              aliases: [],
              confidence: resolvedEntries[0].resolved_booking.confidence,
              matchedAlias: resolvedEntries[0].resolved_booking.matched_alias ?? undefined,
              source: resolvedEntries[0].resolved_booking.source,
            }, "Auto-learned from a successful natural-language booking.")
          : null;

      return formatToolResult(
        {
          user_id: userId,
          activity,
          success: result.success,
          resolved_entry: {
            ticket_id: resolvedEntries[0].ticket_id,
            date: resolvedEntries[0].date,
            hours: resolvedEntries[0].hours,
            description: resolvedEntries[0].description,
            resolved_booking: resolvedEntries[0].resolved_booking,
          },
          learned_alias: learnedAlias
            ? {
                created: learnedAlias.created,
                alias: learnedAlias.alias,
                ticket_code: learnedAlias.ticketCode,
                booking_mode: learnedAlias.bookingMode,
                title: learnedAlias.title ?? null,
              }
            : null,
          result: result.results[0] ?? null,
        },
        result.success
          ? learnedAlias?.created
            ? `Booked ${hours} hour${hours === 1 ? "" : "s"} for '${activity}' on ${entryDate}, and learned '${activity}' as a reusable alias.`
            : `Booked ${hours} hour${hours === 1 ? "" : "s"} for '${activity}' on ${entryDate}.`
          : `Tried to book ${hours} hour${hours === 1 ? "" : "s"} for '${activity}' on ${entryDate}, but TRS reported a failure.`,
      );
    } catch (error) {
      console.error("Failed to book TRS time from activity", {
        activity,
        error: error instanceof Error ? error.message : String(error),
      });
      return formatToolError(error instanceof Error ? error.message : "Failed to book TRS time from activity.");
    }
  },
);

server.registerTool(
  "update_ticket_status_with_comment",
  {
    title: "Update Ticket Status With Comment",
    description:
      "Update a TRS ticket status and add a new comment in the same operation, then return the refreshed ticket context with the newly added comment.",
    inputSchema: {
      ticket_id: z.string().min(1).describe("The TRS ticket identifier to update."),
      new_status: z.string().min(1).describe("The new status string to apply, such as In Progress or Resolved."),
      comment: z.string().min(1).describe("The comment text to add to the ticket."),
    },
  },
  async ({ ticket_id, new_status, comment }) => {
    try {
      const authContext = resolveAuthContext();
      await trsUpdateTicketStatus(ticket_id, new_status, authContext);
      const newComment = await trsAddTicketComment(ticket_id, comment, authContext);
      const updatedTicket = await trsGetTicket(ticket_id, authContext);

      return formatToolResult(
        {
          ticket_id: updatedTicket.ticket_id,
          title: updatedTicket.title,
          status: updatedTicket.status,
          assignee: updatedTicket.assignee,
          customer: updatedTicket.customer,
          description: updatedTicket.description ?? null,
          comments: updatedTicket.comments ?? [],
          new_comment: newComment,
        },
        `Updated TRS ticket ${ticket_id} to ${new_status} and added a new comment.`,
      );
    } catch (error) {
      console.error("Failed to update TRS ticket status and comment", {
        ticketId: ticket_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return formatToolError(error instanceof Error ? error.message : "Failed to update TRS ticket.");
    }
  },
);

server.registerTool(
  "create_ticket_for_customer",
  {
    title: "Create Ticket For Customer",
    description:
      "Create a new TRS ticket for a named customer using a supplied description and an optional title. If no title is provided, the server derives a simple one from the description.",
    inputSchema: {
      customer_name: z.string().min(1).describe("The customer or account name the ticket belongs to."),
      description: z.string().min(1).describe("Full ticket description or issue summary."),
      title: z.string().min(1).optional().describe("Optional ticket title. If omitted, a title is derived automatically."),
    },
  },
  async ({ customer_name, description, title }) => {
    try {
      const authContext = resolveAuthContext();
      const resolvedTitle = title?.trim() || deriveTicketTitle(description);
      const ticket = await trsCreateTicket(customer_name, description, resolvedTitle, authContext);

      return formatToolResult(
        {
          ticket_id: ticket.ticket_id,
          title: ticket.title,
          customer: ticket.customer,
          status: ticket.status,
          assignee: ticket.assignee,
          description: ticket.description ?? null,
        },
        `Created TRS ticket ${ticket.ticket_id} for ${ticket.customer} with status ${ticket.status}.`,
      );
    } catch (error) {
      console.error("Failed to create TRS ticket", {
        customerName: customer_name,
        error: error instanceof Error ? error.message : String(error),
      });
      return formatToolError(error instanceof Error ? error.message : "Failed to create TRS ticket.");
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TRS MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
