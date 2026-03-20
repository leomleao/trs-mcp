import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { addTimeEntriesViaUi } from "./trs-ui-automation.js";
import { autoLearnAlias, resolveBookingSelection } from "./trs-ticket-mappings.js";

const TRS_BASE_URL = process.env.TRS_BASE_URL ?? "https://portal.theconfigteam.co.uk/api";
const TRS_USER_AGENT = "trs-mcp-server/1.0";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface AuthContext {
  userId?: string;
  token?: string;
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

  async post<T>(
    path: string,
    authContext: AuthContext,
    body?: Record<string, JsonValue> | JsonValue[],
  ): Promise<T> {
    return this.request<T>("POST", path, authContext, body);
  }

  private async request<T>(
    method: "POST",
    path: string,
    authContext: AuthContext,
    body?: Record<string, JsonValue> | JsonValue[],
  ): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TRS MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
