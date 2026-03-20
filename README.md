# TRS MCP Server

TypeScript MCP server for TRS timesheet workflows.

Current tools:

- `book_time_from_activity`

Environment variables:

- `TRS_BASE_URL` optional, defaults to `https://portal.theconfigteam.co.uk/api`
- `TRS_API_TOKEN` optional placeholder for technical-token auth
- `TRS_USER_ID` optional placeholder for current-user identity
- `TRS_USE_UI_AUTOMATION` set to `1` to drive the portal UI via Edge/Playwright when no API token is available
- `TRS_LOGIN_USERNAME` optional username to pre-fill on the login form
- `TRS_BROWSER_DATA_DIR` optional persistent browser profile directory
- `TRS_BROWSER_EXECUTABLE_PATH` optional custom Edge executable path

Current support notes:

- `book_time_from_activity` is the simplest way to book a single entry from natural language like `inbox and ticket management`, and it can auto-learn new phrases into the custom alias store after a successful booking.
- AMS time-booking synonym seeds are defined separately in [`src/trs-ticket-mappings.ts`](src/trs-ticket-mappings.ts).
- [`trs-ticket-synonyms.json`](trs-ticket-synonyms.json) starts empty by design and stores only learned/custom aliases, not the built-in AMS seed mappings.
- Custom natural-language aliases are persisted in [`trs-ticket-synonyms.json`](trs-ticket-synonyms.json) and auto-learned after each successful booking.

## Possible future features

- `get_ticket_and_summarise_comments` — fetch a TRS ticket by ID and return a natural-language summary of its comment history
- `list_my_tickets_for_week` — list tickets assigned to the current user within a date range
- `list_time_booking_mappings` — list seeded and custom alias mappings
- `upsert_time_booking_alias` — create or update a custom alias for natural-language time booking
- `add_timesheet_entries_for_week` — bulk-add multiple timesheet entries in one call
- `update_ticket_status_with_comment` — update ticket status and add a comment atomically
- `create_ticket_for_customer` — create a new TRS ticket for a named customer
