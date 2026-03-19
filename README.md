# TRS MCP Server

TypeScript MCP server for TRS ticketing and timesheet workflows.

Current tools:

- `get_ticket_and_summarise_comments`
- `list_my_tickets_for_week`
- `list_time_booking_mappings`
- `upsert_time_booking_alias`
- `add_timesheet_entries_for_week`
- `book_time_from_activity`
- `update_ticket_status_with_comment`
- `create_ticket_for_customer`

Environment variables:

- `TRS_BASE_URL` optional, defaults to `https://portal.theconfigteam.co.uk/api`
- `TRS_API_TOKEN` optional placeholder for technical-token auth
- `TRS_USER_ID` optional placeholder for current-user identity
- `TRS_USE_UI_AUTOMATION` set to `1` to drive the portal UI via Edge/Playwright when no API token is available
- `TRS_LOGIN_USERNAME` optional username to pre-fill on the login form
- `TRS_BROWSER_DATA_DIR` optional persistent browser profile directory
- `TRS_BROWSER_EXECUTABLE_PATH` optional custom Edge executable path

Current support notes:

- `add_timesheet_entries_for_week` can run through UI automation with an interactive Edge login session.
- `book_time_from_activity` is the simplest way to book a single entry from natural language like `inbox and ticket management`, and it can auto-learn new phrases into the custom alias store after a successful booking.
- AMS time-booking synonym seeds are defined separately in [`src/trs-ticket-mappings.ts`](C:/Dev/trs-mcp/src/trs-ticket-mappings.ts).
- [`trs-ticket-synonyms.json`](C:/Dev/trs-mcp/trs-ticket-synonyms.json) starts empty by design and stores only learned/custom aliases, not the built-in AMS seed mappings.
- Custom natural-language aliases are persisted in [`trs-ticket-synonyms.json`](C:/Dev/trs-mcp/trs-ticket-synonyms.json) and can be managed through MCP.
- The other tools still use placeholder HTTP endpoints in [`src/index.ts`](C:/Dev/trs-mcp/src/index.ts) and need real TRS API wiring before they will work end-to-end.
