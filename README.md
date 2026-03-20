# TRS MCP Server

TypeScript MCP server for TRS timesheet and ticket workflows, driven via Edge/Playwright UI automation.

## Tools

### `book_time_from_activity`

Book a single TRS timesheet entry from a natural-language activity description such as `inbox and ticket management`. The server resolves the booking code automatically using seeded and custom alias mappings, and can auto-learn new phrases into the custom alias store after a successful booking.

### `get_ticket_context`

Retrieve the full context for a TRS ticket by ID (e.g. `TCTEVI-7343`). Returns:

- **General info** — title, details, priority, client location, service type, external ID, client project, reported by, client contact, logged by
- **Comments** — full comment history with author, date, and context type (Customer facing / Work note / Internal)
- **Linked tickets** — recursively extracts the same data for all tickets linked under the HD Links tab, tracking already-visited tickets to handle bidirectional links without infinite loops

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TRS_BASE_URL` | No | Portal base URL, defaults to `https://portal.theconfigteam.co.uk/api` |
| `TRS_API_TOKEN` | No | Placeholder for token-based auth |
| `TRS_USER_ID` | No | Placeholder for current-user identity |
| `TRS_USE_UI_AUTOMATION` | No | Set to `1` to force UI automation even when an API token is set |
| `TRS_LOGIN_USERNAME` | No | Pre-fills the username field on the portal login form |
| `TRS_BROWSER_DATA_DIR` | No | Path to a persistent browser profile directory |
| `TRS_BROWSER_EXECUTABLE_PATH` | No | Path to a custom Edge executable |

## Implementation notes

- `book_time_from_activity` resolves ticket codes via seeded AMS mappings in [`src/trs-ticket-mappings.ts`](src/trs-ticket-mappings.ts) and learned custom aliases in [`trs-ticket-synonyms.json`](trs-ticket-synonyms.json). The JSON file starts empty and grows automatically.
- `get_ticket_context` uses Playwright to navigate the portal. Ticket content is rendered inside an iframe — the implementation searches all page frames for `#tabGeneral` rather than assuming a fixed frame URL.
- Linked ticket IDs are read from the first column of the HD Links table (`#udp_Links_HD`), where the portal stores the canonical text ID (e.g. `TCTLAOR-138`).

## Possible future features

- `list_my_tickets_for_week` — list tickets assigned to the current user within a date range
- `list_time_booking_mappings` — list seeded and custom alias mappings
- `upsert_time_booking_alias` — create or update a custom alias for natural-language time booking
- `add_timesheet_entries_for_week` — bulk-add multiple timesheet entries in one call
- `update_ticket_status_with_comment` — update ticket status and add a comment atomically
- `create_ticket_for_customer` — create a new TRS ticket for a named customer
