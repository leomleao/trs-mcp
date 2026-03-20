import path from "path";
import readline from "readline";
import { chromium, BrowserContext, Frame, Locator, Page } from "playwright";
import { resolveBookingSelection } from "./trs-ticket-mappings.js";

export interface TimeEntry {
  ticketId: string;
  date: string; // YYYY-MM-DD
  hours: number; // decimal hours, e.g. 0.25
  description: string;
  bookingMode?: "favourite" | "search";
}

export interface AutomationOptions {
  baseUrl?: string;
  headless?: boolean;
  userDataDir?: string;
  browserExecutablePath?: string;
  timeoutMs?: number;
  keepOpen?: boolean;
  debug?: boolean;
  retryAttempts?: number;
}

const DEFAULT_BASE_URL = "https://portal.theconfigteam.co.uk";

type UiStepError =
  | "day_tab_not_found"
  | "add_time_modal_not_found"
  | "ticket_picker_not_found"
  | "comment_editor_not_found"
  | "submit_failed"
  | "entry_row_not_detected";

interface UiActionResult {
  success: boolean;
  error?: string;
  screenshotPath?: string;
  warning?: string;
}

type InteractionRoot = Page | Frame;

function readLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function launchEdge(options: AutomationOptions): Promise<{ context: BrowserContext; page: Page }> {
  // Determine user data directory: prioritize env var, then options, then user home
  let userDataDir = process.env.TRS_BROWSER_DATA_DIR;
  if (!userDataDir && options.userDataDir) {
    userDataDir = options.userDataDir;
  }
  if (!userDataDir) {
    // Use AppData or home directory for a writable location
    const homeDir = process.env.USERPROFILE || process.env.HOME || process.env.HOMEPATH || ".";
    userDataDir = path.join(homeDir, ".trs-browser-data");
  }

  const executablePath = options.browserExecutablePath ?? process.env.TRS_BROWSER_EXECUTABLE_PATH;

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless ?? false,
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ["--enable-automation"],
    ...(executablePath ? { executablePath } : { channel: "msedge" }),
  });

  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(options.timeoutMs ?? 60_000);
  return { context, page };
}

async function isAuthenticatedPortalPage(page: Page, baseUrl: string): Promise<boolean> {
  const url = page.url();
  if (url.startsWith(`${baseUrl}/time_recording/edit/`) || url.startsWith(`${baseUrl}/`)) {
    const passwordFields = await page.locator("input[type='password']").count();
    return passwordFields === 0;
  }
  return false;
}

async function clickIfVisible(locator: Locator): Promise<boolean> {
  if ((await locator.count()) === 0) {
    return false;
  }

  const target = locator.first();
  if (!(await target.isVisible().catch(() => false))) {
    return false;
  }

  await target.click().catch(() => undefined);
  return true;
}

async function clickAzureLoginButton(page: Page): Promise<boolean> {
  const azureCandidates = [
    page.locator("input[type='submit'][value*='Azure' i]"),
    page.locator("button").filter({ hasText: /azure|microsoft|office 365|single sign on|sso/i }),
    page.locator("a").filter({ hasText: /azure|microsoft|office 365|single sign on|sso/i }),
    page.locator("[id*='azure' i], [id*='microsoft' i], [class*='azure' i], [class*='microsoft' i]"),
  ];

  for (const candidate of azureCandidates) {
    if (await clickIfVisible(candidate)) {
      return true;
    }
  }

  return false;
}

async function selectFirstAzureAccount(page: Page): Promise<boolean> {
  const accountCandidates = [
    page.locator("[data-test-id='authenticator-account-list-item']"),
    page.locator("[role='listitem']").filter({ has: page.locator("img, div, span") }),
    page.locator("div").filter({ hasText: /@/ }),
    page.locator("button").filter({ hasText: /@/ }),
  ];

  for (const candidate of accountCandidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }

    const first = candidate.first();
    if (await first.isVisible().catch(() => false)) {
      await first.click().catch(() => undefined);
      return true;
    }
  }

  return false;
}

async function handleAzureStaySignedIn(page: Page): Promise<void> {
  const confirmCandidates = [
    page.locator("input[type='submit'][value='Yes']"),
    page.locator("button").filter({ hasText: /^yes$/i }),
    page.locator("input[type='submit'][value='Continue']"),
    page.locator("button").filter({ hasText: /^continue$/i }),
  ];

  for (const candidate of confirmCandidates) {
    if (await clickIfVisible(candidate)) {
      await page.waitForLoadState("networkidle").catch(() => undefined);
      return;
    }
  }
}

async function attemptAzureAutoLogin(page: Page, baseUrl: string): Promise<boolean> {
  const clickedAzure = await clickAzureLoginButton(page);
  if (!clickedAzure) {
    return false;
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1000);

  const pickedAccount = await selectFirstAzureAccount(page);
  if (pickedAccount) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(1000);
  }

  await handleAzureStaySignedIn(page);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(1000);

  return isAuthenticatedPortalPage(page, baseUrl);
}

async function handleLoginIfNeeded(page: Page, baseUrl: string): Promise<void> {
  const isLoginPage = await page.locator("input[type=password]").first().count().then((c) => c > 0);
  if (!isLoginPage) {
    return;
  }

  const loginUsername = process.env.TRS_LOGIN_USERNAME;
  const usernameField = page.locator("input[name=txtUsername]");
  if (loginUsername && (await usernameField.count()) > 0) {
    await usernameField.fill(loginUsername);
  }

  const autoLoggedIn = await attemptAzureAutoLogin(page, baseUrl);
  if (autoLoggedIn) {
    return;
  }

  console.log("Please log in to the TRS portal in the opened browser window.");
  if (loginUsername) {
    console.log(`Username '${loginUsername}' has been pre-filled where possible.`);
  }
  console.log("After login completes and you are on the main dashboard, press ENTER to continue.");
  await readLine("");
}

async function waitForLogin(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await handleLoginIfNeeded(page, baseUrl);
}

function formatHourValue(hours: number): string {
  return hours.toString();
}

function shouldUseSearchMode(ticketId: string): boolean {
  // If ticket id looks like a ticket code (contains letters and a hyphen), use search.
  return /[A-Za-z]+-\d+/.test(ticketId);
}

function formatUiError(step: UiStepError, detail?: string): string {
  return detail ? `${step}: ${detail}` : step;
}

async function captureDebugScreenshot(page: Page, label: string, debug: boolean): Promise<string | undefined> {
  if (!debug) return undefined;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(process.cwd(), `trs-debug-${label}-${ts}.png`);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => undefined);
  return filePath;
}

function getInteractionRoots(page: Page): InteractionRoot[] {
  return [page, ...page.frames()];
}

async function getVisibleCount(root: InteractionRoot, selector: string): Promise<number> {
  const locator = root.locator(selector);
  const count = await locator.count();
  let visible = 0;

  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      visible += 1;
    }
  }

  return visible;
}

async function findTimeRecordingRoot(page: Page): Promise<InteractionRoot> {
  const roots = getInteractionRoots(page);
  let bestRoot: InteractionRoot = page;
  let bestScore = -1;

  for (const root of roots) {
    const score = await getVisibleCount(root, "input[value='Add Time']");
    if (score > bestScore) {
      bestScore = score;
      bestRoot = root;
    }
  }

  return bestRoot;
}

async function ensureOnEditTimePage(page: Page, baseUrl: string): Promise<void> {
  const editTimeUrl = `${baseUrl}/time_recording/edit/`;
  await page.goto(editTimeUrl, { waitUntil: "networkidle" });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const root = await findTimeRecordingRoot(page);
    if ((await root.locator("input[value='Add Time']").count()) > 0) {
      return;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(formatUiError("add_time_modal_not_found", "Edit Time page loaded, but no Add Time buttons were found in the page or its iframes."));
}

function dayTokensForEntry(entry: TimeEntry): string[] {
  const date = new Date(`${entry.date}T00:00:00`);
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const shortWeekday = date.toLocaleDateString("en-GB", { weekday: "short" });
  return [weekday, shortWeekday, entry.date];
}

async function findDayContext(
  root: InteractionRoot,
  page: Page,
  entry: TimeEntry,
): Promise<{ tab: Locator; container: Locator }> {
  const tokens = dayTokensForEntry(entry);
  const tabCandidates = [
    root.locator("[role='tab']"),
    root.locator("a"),
    root.locator("button"),
    root.locator("li"),
  ];

  for (const token of tokens) {
    const pattern = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    for (const tabList of tabCandidates) {
      const matchingTab = tabList.filter({ hasText: pattern }).first();
      if ((await matchingTab.count()) === 0) {
        continue;
      }

      await matchingTab.click().catch(() => undefined);
      await page.waitForTimeout(400);

      const directContainer = root.locator(
        [
          `[data-day='${entry.date}']`,
          `[data-date='${entry.date}']`,
          `#${shortId(token)}`,
        ].join(", "),
      );
      if ((await directContainer.count()) > 0) {
        return { tab: matchingTab, container: directContainer.first() };
      }

      const nearbyContainer = matchingTab.locator("xpath=ancestor::*[self::div or self::section or self::li][1]");
      if ((await nearbyContainer.count()) > 0) {
        return { tab: matchingTab, container: nearbyContainer.first() };
      }

      return { tab: matchingTab, container: root.locator("body") };
    }
  }

  throw new Error(formatUiError("day_tab_not_found", `Could not find a tab for ${entry.date}.`));
}

function shortId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function compactDate(date: string): string {
  return date.replace(/-/g, "");
}

async function findVisibleModal(page: Page): Promise<Locator | null> {
  const selectors = [
    "[role='dialog']",
    ".modal.show",
    ".modal:visible",
    ".ui-dialog:visible",
    ".popup:visible",
    ".dialog:visible",
  ];

  for (const root of getInteractionRoots(page)) {
    for (const selector of selectors) {
      const modal = root
        .locator(selector)
        .filter({ has: root.locator("input, textarea, iframe, select, button") })
        .last();
      if ((await modal.count()) > 0 && (await modal.isVisible().catch(() => false))) {
        return modal;
      }
    }
  }

  return null;
}

async function openAddTimeModal(dayContainer: Locator, root: InteractionRoot, page: Page): Promise<Locator | null> {
  const dateToken = compactDate(
    await dayContainer
      .evaluate((node) => node.getAttribute("data-date") ?? node.getAttribute("data-day") ?? "")
      .catch(() => ""),
  );
  const addButtonCandidates = [
    ...(dateToken
      ? [
          root.locator(`input#cphB_butAdd_${dateToken}[value='Add Time']`),
          root.locator(`input[name*='$butAdd_${dateToken}'][value='Add Time']`),
        ]
      : []),
    dayContainer.locator("input[id^='cphB_butAdd_'][value='Add Time']"),
    dayContainer.locator("input[name*='$butAdd_'][value='Add Time']"),
    dayContainer.locator("input[value='Add Time']"),
    dayContainer.getByRole("button", { name: /^Add Time$/i }),
    dayContainer.getByRole("link", { name: /^Add Time$/i }),
    root.locator("input[id^='cphB_butAdd_'][value='Add Time']"),
    root.locator("input[name*='$butAdd_'][value='Add Time']"),
    root.locator("input[value='Add Time']"),
  ];

  for (const candidate of addButtonCandidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }

    const button = candidate.first();
    await button.scrollIntoViewIfNeeded().catch(() => undefined);
    await button.click({ timeout: 5_000 }).catch(async () => {
      await button.click({ force: true, timeout: 5_000 }).catch(async () => {
        await button.evaluate((element) => {
          const target = element as HTMLInputElement;
          target.click();
        });
      });
    });

    const modal = await waitForAddTimeModal(page);
    if (modal) {
      return modal;
    }
  }

  return null;
}

async function waitForAddTimeModal(page: Page): Promise<Locator | null> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const modal = await findVisibleModal(page);
    if (modal) {
      return modal;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function chooseFavouriteOption(
  selectControl: Locator,
  ticketId: string,
  description: string,
  resolvedTicketCode?: string,
  resolvedTitle?: string,
): Promise<boolean> {
  const options = selectControl.locator("option");
  const optionCount = await options.count();
  await selectControl.scrollIntoViewIfNeeded().catch(() => undefined);
  await selectControl.hover().catch(() => undefined);
  await selectControl.click().catch(() => undefined);

  async function commitSelection(selectedValue: string): Promise<boolean> {
    const targetIndex = await selectControl.evaluate((element, value) => {
      const select = element as HTMLSelectElement;
      const optionIndex = Array.from(select.options).findIndex((entry) => entry.value === value);
      if (optionIndex >= 0) {
        select.selectedIndex = optionIndex;
        select.value = value;
        select.options[optionIndex].selected = true;
      }
      if (typeof select.onchange === "function") {
        select.onchange(new Event("change", { bubbles: true }));
      }
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      select.dispatchEvent(new Event("blur", { bubbles: true }));
      return optionIndex;
    }, selectedValue).catch(() => -1);

    await selectControl.selectOption(selectedValue).catch(() => undefined);

    if (targetIndex >= 0) {
      await selectControl.focus().catch(() => undefined);
      await selectControl.press("Home").catch(() => undefined);
      for (let index = 0; index < targetIndex; index += 1) {
        await selectControl.press("ArrowDown").catch(() => undefined);
      }
      await selectControl.press("Enter").catch(() => undefined);
    }

    await selectControl.press("Tab").catch(() => undefined);
    await selectControl.blur().catch(() => undefined);
    await selectControl.hover().catch(() => undefined);

    const currentValue = await selectControl.inputValue().catch(() => "");
    return currentValue === selectedValue;
  }

  const exactValueOption = selectControl.locator(`option[value="${ticketId}"]`).first();
  if ((await exactValueOption.count()) > 0) {
    return commitSelection(ticketId);
  }

  const rankedKeywords = [
    resolvedTicketCode,
    resolvedTitle,
    ticketId,
    description,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim().toLowerCase());

  for (const keyword of rankedKeywords) {
    for (let index = 0; index < optionCount; index += 1) {
      const option = options.nth(index);
      const value = (await option.getAttribute("value").catch(() => "")) ?? "";
      const label = ((await option.textContent().catch(() => "")) ?? "").trim().toLowerCase();
      if (!value || !label) {
        continue;
      }
      if (label.includes(keyword)) {
        if (await commitSelection(value)) {
          return true;
        }
      }
    }
  }

  for (const keyword of rankedKeywords) {
    for (let index = 0; index < optionCount; index += 1) {
      const option = options.nth(index);
      const value = (await option.getAttribute("value").catch(() => "")) ?? "";
      const label = ((await option.textContent().catch(() => "")) ?? "").trim().toLowerCase();
      if (!value || !label) {
        continue;
      }

      const normalizedKeywordTokens = keyword.split(/\s+/).filter(Boolean);
      const overlap = normalizedKeywordTokens.filter((token) => label.includes(token)).length;
      if (overlap >= Math.max(2, Math.min(3, normalizedKeywordTokens.length))) {
        if (await commitSelection(value)) {
          return true;
        }
      }
    }
  }

  const currentValue = await selectControl.inputValue().catch(() => "");
  if (currentValue) {
    const currentLabelText =
      (await selectControl.locator(`option[value="${currentValue}"]`).first().textContent().catch(() => "")) ?? "";
    const currentLabel = currentLabelText.trim().toLowerCase();
    if (
      rankedKeywords.some((keyword) => currentLabel.includes(keyword)) ||
      (resolvedTicketCode ? currentLabel.includes(resolvedTicketCode.toLowerCase()) : false)
    ) {
      return true;
    }
  }

  return false;
}

async function clickAutocompleteSuggestion(page: Page, ticketId: string): Promise<boolean> {
  const suggestionSelectors = [
    "ul.ui-autocomplete li",
    ".ui-autocomplete li",
    "[role='listbox'] [role='option']",
    "[role='option']",
  ];

  for (const selector of suggestionSelectors) {
    const suggestions = page.locator(selector);
    const count = await suggestions.count();
    if (count === 0) {
      continue;
    }

    for (let index = 0; index < count; index += 1) {
      const suggestion = suggestions.nth(index);
      const text = ((await suggestion.textContent().catch(() => "")) ?? "").trim();
      if (!text) {
        continue;
      }

      if (text.toLowerCase().includes(ticketId.toLowerCase())) {
        await suggestion.click().catch(() => undefined);
        return true;
      }
    }

    const firstVisible = suggestions.first();
    if (await firstVisible.isVisible().catch(() => false)) {
      await firstVisible.click().catch(() => undefined);
      return true;
    }
  }

  return false;
}

async function selectTicketViaSearch(page: Page, modal: Locator, ticketCode: string): Promise<UiActionResult> {
  const searchToggle =
    (await findFirstVisibleLocator(page, [
      "#radSch",
      "input[type='radio'][id='radSch']",
      "input[type='radio'][value='radSch']",
      "label[for='radSch']",
    ])) ??
    modal.locator(
      "#radSch, input[type='radio'][value*='Sch'], input[type='radio'][id*='radSch'], label[for='radSch']",
    ).first();

  if ((await searchToggle.count()) > 0) {
    await searchToggle.check().catch(async () => {
      await searchToggle.click().catch(() => undefined);
    });
  }

  // Wait for the search input to become visible after the radio toggle
  const searchInputSelectors = [
    "#txt_tr_sch",
    "input[id='txt_tr_sch']",
    "input[name='txt_tr_sch']",
    "input[id*='txt_tr_sch']",
    "input[name*='txt_tr_sch']",
  ];
  let searchInput: Locator | null = null;
  const visibilityDeadline = Date.now() + 5_000;
  while (Date.now() < visibilityDeadline) {
    searchInput = await findFirstVisibleLocator(page, searchInputSelectors);
    if (searchInput && (await searchInput.isVisible().catch(() => false))) break;
    searchInput = null;
    await page.waitForTimeout(200);
  }

  if (!searchInput) {
    return {
      success: false,
      error: formatUiError(
        "ticket_picker_not_found",
        `Search input not found after toggling search radio. Tried selectors: #txt_tr_sch, input[name='txt_tr_sch'], input[id*='txt_tr_sch'], input[name*='txt_tr_sch']. Page URL: ${page.url()}`,
      ),
    };
  }

  await searchInput.fill(ticketCode);
  await page.waitForTimeout(500);
  const clickedSuggestion = await clickAutocompleteSuggestion(page, ticketCode);
  if (!clickedSuggestion) {
    await searchInput.press("ArrowDown").catch(() => undefined);
    await searchInput.press("Enter").catch(() => undefined);
  }
  await page.waitForTimeout(700);
  return { success: true };
}

async function findFirstVisibleLocator(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const root of getInteractionRoots(page)) {
    for (const selector of selectors) {
      const locator = root.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        return locator;
      }
    }
  }

  for (const root of getInteractionRoots(page)) {
    for (const selector of selectors) {
      const locator = root.locator(selector).first();
      if ((await locator.count()) > 0) {
        return locator;
      }
    }
  }

  return null;
}

async function selectTicket(
  modal: Locator,
  page: Page,
  ticketId: string,
  description: string,
  bookingMode?: "favourite" | "search",
): Promise<UiActionResult> {
  const resolution = await resolveBookingSelection(ticketId, description);
  const resolvedTicketCode = resolution?.ticketCode ?? ticketId;
  const resolvedTitle = resolution?.title;
  const effectiveMode = bookingMode ?? resolution?.mode;
  const useSearch = effectiveMode ? effectiveMode === "search" : shouldUseSearchMode(resolvedTicketCode);

  if (useSearch) {
    return selectTicketViaSearch(page, modal, resolvedTicketCode);
  }

  const favouritesToggle =
    (await findFirstVisibleLocator(page, [
      "#radFav",
      "input[type='radio'][id='radFav']",
      "input[type='radio'][value='radFav']",
      "label[for='radFav']",
    ])) ??
    modal.locator(
      "#radFav, input[type='radio'][value*='Fav'], input[type='radio'][id*='radFav'], label[for='radFav']",
    ).first();

  if ((await favouritesToggle.count()) > 0) {
    await favouritesToggle.check().catch(async () => {
      await favouritesToggle.click().catch(() => undefined);
    });
  }
  await page.waitForTimeout(700);

  const select = await findFirstVisibleLocator(page, [
    "#ddl_tr_favs",
    "select[name='ddl_tr_favs']",
    "select[id='ddl_tr_favs']",
    "select[id*='ddl_tr_favs']",
  ]);
  if (!select || (await select.count()) === 0) {
    return {
      success: false,
      error: formatUiError("ticket_picker_not_found", "Favourites ticket selector was not found in the Add Time modal."),
    };
  }

  const selected = await chooseFavouriteOption(select, ticketId, description, resolvedTicketCode, resolvedTitle);
  if (selected) {
    const selectedValue = await select.inputValue().catch(() => "");
    if (selectedValue) {
      return { success: true };
    }
  }

  if (resolvedTicketCode) {
    return selectTicketViaSearch(page, modal, resolvedTicketCode);
  }

  return {
    success: false,
    error: formatUiError(
      "ticket_picker_not_found",
      `The favourites dropdown did not retain the selected ticket for '${resolvedTicketCode || description}'.`,
    ),
  };
}

async function fillTinyMceComment(page: Page, modal: Locator, text: string): Promise<UiActionResult> {
  let fillAttempted = false;

  const iframeLocator =
    (await findFirstVisibleLocator(page, [
      "#txt_tr_comments_ifr",
      "iframe[id='txt_tr_comments_ifr']",
      "iframe[id*='txt_tr_comments_ifr']",
      "iframe[title*='Rich Text Area']",
      "iframe[title*='Rich Text']",
    ])) ?? modal.locator("#txt_tr_comments_ifr, iframe[id*='txt_tr_comments_ifr'], iframe[title*='Rich Text']").first();

  if (iframeLocator && (await iframeLocator.count()) > 0) {
    const frame = await iframeLocator.elementHandle().then((handle) => handle?.contentFrame()).catch(() => null);
    if (frame) {
      const body = frame.locator("body");
      await body.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
      fillAttempted = true;
      await body.fill(text).catch(() => undefined);
      const bodyText = (await body.innerText().catch(() => "")).trim();
      if (bodyText.toLowerCase().includes(text.toLowerCase())) {
        return { success: true };
      }
    }
  }

  for (const root of getInteractionRoots(page)) {
    const editorBody = root.locator("body#tinymce, body.mce-content-body, body[contenteditable='true']").first();
    if ((await editorBody.count()) > 0 && (await editorBody.isVisible().catch(() => false))) {
      fillAttempted = true;
      await editorBody.fill(text).catch(() => undefined);
      const bodyText = (await editorBody.innerText().catch(() => "")).trim();
      if (bodyText.toLowerCase().includes(text.toLowerCase())) {
        return { success: true };
      }
    }
  }

  return {
    success: true,
    warning: fillAttempted
      ? formatUiError("comment_editor_not_found", "TinyMCE fill was attempted but content readback did not confirm it was set. Verify comment in TRS.")
      : formatUiError("comment_editor_not_found", "TinyMCE comment editor was not found; comment was not set. Verify in TRS."),
  };
}

async function findDurationInput(page: Page, modal: Locator): Promise<Locator | null> {
  const globalMatch = await findFirstVisibleLocator(page, [
    "#txt_tr_duration",
    "input[name='txt_tr_duration']",
    "input[id='txt_tr_duration']",
    "input[id*='txt_tr_duration']",
    "input[name*='txt_tr_duration']",
  ]);

  if (globalMatch) {
    return globalMatch;
  }

  const modalMatch = modal
    .locator("#txt_tr_duration, input[id*='txt_tr_duration'], input[name*='txt_tr_duration']")
    .first();
  if ((await modalMatch.count()) > 0) {
    return modalMatch;
  }

  return null;
}

async function extractVisibleValidationText(modal: Locator): Promise<string | undefined> {
  const validationCandidates = modal.locator(
    ".validation-summary-errors, .field-validation-error, .error, .alert, .message, [role='alert']",
  );
  const count = await validationCandidates.count();
  const messages: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const candidate = validationCandidates.nth(index);
    const text = (await candidate.innerText().catch(() => "")).trim();
    if (text) {
      messages.push(text);
    }
  }

  return messages.length > 0 ? messages.join(" | ") : undefined;
}

async function extractPageMessages(root: InteractionRoot): Promise<string | undefined> {
  const messageCandidates = root.locator(
    ".validation-summary-errors, .field-validation-error, .error, .alert, .message, .success, [role='alert']",
  );
  const count = await messageCandidates.count().catch(() => 0);
  const messages: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const candidate = messageCandidates.nth(index);
    const text = (await candidate.innerText().catch(() => "")).trim();
    if (text) {
      messages.push(text);
    }
  }

  return messages.length > 0 ? messages.join(" | ") : undefined;
}

async function waitForModalToClose(modal: Locator, page: Page): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const visible = await modal.isVisible().catch(() => false);
    if (!visible) {
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function countEntryRows(page: Page, entry: TimeEntry): Promise<number> {
  // Count how many times the ticket ID or description appear in the full page text across all frames.
  // Used to detect whether a new row was actually added (before vs after comparison).
  const patterns = [entry.ticketId, entry.description]
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  let maxCount = 0;
  for (const root of getInteractionRoots(page)) {
    const text = (await root.locator("body").innerText().catch(() => "")).toLowerCase();
    for (const pattern of patterns) {
      let count = 0;
      let pos = 0;
      while ((pos = text.indexOf(pattern, pos)) !== -1) { count++; pos += pattern.length; }
      if (count > maxCount) maxCount = count;
    }
  }
  return maxCount;
}


async function submitAddTimeModal(page: Page, modal: Locator): Promise<UiActionResult> {
  const submitButton =
    (await findFirstVisibleLocator(page, [
      "#openTime_Add",
      "button#openTime_Add",
      "button[id='openTime_Add']",
      "button:has-text('Add Time')",
      "input[value='Add Time']",
      "input[type='submit'][value='Add Time']",
    ])) ??
    modal
      .locator("button#openTime_Add, input[value='Add Time'], button, input[type='submit']")
      .filter({ hasText: /Add Time|Save|Submit/i })
      .first();

  if ((await submitButton.count()) === 0) {
    return {
      success: false,
      error: formatUiError(
        "submit_failed",
        `Submit button not found. Tried selectors: #openTime_Add, button#openTime_Add, button:has-text('Add Time'), input[value='Add Time'], input[type='submit'][value='Add Time']. Page URL: ${page.url()}`,
      ),
    };
  }

  await submitButton.scrollIntoViewIfNeeded().catch(() => undefined);
  await submitButton.click().catch(async () => {
    await submitButton.click({ force: true }).catch(async () => {
      await submitButton.evaluate((element) => {
        (element as HTMLButtonElement | HTMLInputElement).click();
      });
    });
  });
  return { success: true };
}

async function withRetry<T>(
  attempts: number,
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
): Promise<T> {
  let last!: T;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await fn();
    if (!shouldRetry(last)) return last;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  return last;
}

async function addEntryToPage(page: Page, entry: TimeEntry, debug: boolean, retries: number): Promise<UiActionResult> {
  try {
    const root = await findTimeRecordingRoot(page);
    const { container } = await findDayContext(root, page, entry);
    const datedButton = root.locator(
      [
        `input#cphB_butAdd_${compactDate(entry.date)}[value='Add Time']`,
        `input[name*='$butAdd_${compactDate(entry.date)}'][value='Add Time']`,
      ].join(", "),
    );

    // Open modal with retry
    const modal = await withRetry(
      retries,
      async () => {
        if ((await datedButton.count()) > 0) {
          const button = datedButton.first();
          await button.scrollIntoViewIfNeeded().catch(() => undefined);
          await button.click({ timeout: 5_000 }).catch(async () => {
            await button.click({ force: true, timeout: 5_000 }).catch(async () => {
              await button.evaluate((element) => {
                (element as HTMLInputElement).click();
              });
            });
          });
          return waitForAddTimeModal(page);
        }
        return openAddTimeModal(container, root, page);
      },
      (result) => result === null,
    );

    if (!modal) {
      const screenshotPath = await captureDebugScreenshot(page, "modal-open-failed", debug);
      return {
        success: false,
        screenshotPath,
        error: formatUiError(
          "add_time_modal_not_found",
          `Could not open the Add Time modal after ${retries} attempt(s). Tried ${
            (await datedButton.count()) > 0 ? "dated button then " : ""
          }Add Time button candidates. Page URL: ${page.url()}`,
        ),
      };
    }

    // Select ticket with retry
    const ticketResult = await withRetry(
      retries,
      () => selectTicket(modal, page, entry.ticketId, entry.description, entry.bookingMode),
      (result) => !result.success,
    );
    if (!ticketResult.success) {
      const screenshotPath = await captureDebugScreenshot(page, "ticket-selection-failed", debug);
      return { ...ticketResult, screenshotPath };
    }

    const duration = await findDurationInput(page, modal);
    if (!duration || (await duration.count()) === 0) {
      const screenshotPath = await captureDebugScreenshot(page, "duration-not-found", debug);
      return {
        success: false,
        screenshotPath,
        error: formatUiError("submit_failed", `Duration input (#txt_tr_duration) was not found. Page URL: ${page.url()}`),
      };
    }
    await duration.fill(formatHourValue(entry.hours));

    // TinyMCE: collect warning, never abort
    const commentResult = await fillTinyMceComment(page, modal, entry.description);
    const commentWarning = commentResult.warning;

    // Snapshot row count before submitting so we can detect duplicates
    const rowCountBefore = await countEntryRows(page, entry).catch(() => 0);

    const submitResult = await submitAddTimeModal(page, modal);
    if (!submitResult.success) {
      const screenshotPath = await captureDebugScreenshot(page, "submit-failed", debug);
      return { ...submitResult, screenshotPath };
    }

    const modalClosed = await waitForModalToClose(modal, page);
    if (!modalClosed) {
      const validationText = await extractVisibleValidationText(modal);
      const screenshotPath = await captureDebugScreenshot(page, "modal-not-closed", debug);
      return {
        success: false,
        screenshotPath,
        error: formatUiError(
          "submit_failed",
          (validationText ?? "The Add Time modal did not close after submit.") + ` | Page URL: ${page.url()}`,
        ),
      };
    }

    await page.waitForTimeout(1500);
    const rowCountAfter = await countEntryRows(page, entry).catch(() => rowCountBefore);
    const newRowAdded = rowCountAfter > rowCountBefore;
    const pageMessages = await extractPageMessages(root).catch(() => undefined);
    const screenshotPath = await captureDebugScreenshot(page, "post-submit", debug);

    const rowWarning = !newRowAdded
      ? formatUiError(
          "entry_row_not_detected",
          rowCountBefore > 0
            ? `No new row detected — an entry for '${entry.ticketId || entry.description}' already existed (${rowCountBefore} match(es) before submit). Possible duplicate rejected by portal.`
            : pageMessages
            ? `No new row for '${entry.ticketId || entry.description}' detected. Page messages: ${pageMessages}`
            : `No new row for '${entry.ticketId || entry.description}' detected. Modal closed — verify in TRS that the entry was saved.`,
        )
      : undefined;

    const allWarnings = [commentWarning, rowWarning, pageMessages && !rowWarning ? `post_submit_note: ${pageMessages}` : undefined]
      .filter(Boolean)
      .join(" | ");

    return {
      success: true,
      screenshotPath,
      warning: allWarnings || undefined,
    };
  } catch (err) {
    const screenshotPath = await captureDebugScreenshot(page, "uncaught-error", debug);
    return {
      success: false,
      screenshotPath,
      error: err instanceof Error ? err.message : formatUiError("submit_failed", String(err)),
    };
  }
}

function formatDateForPicker(isoDate: string): string {
  // Produces "Wednesday, 18 March 2026" to match the portal's datepicker format
  const date = new Date(`${isoDate}T12:00:00`);
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const day = date.getDate();
  const month = date.toLocaleDateString("en-GB", { month: "long" });
  const year = date.getFullYear();
  return `${weekday}, ${day} ${month} ${year}`;
}

async function fillDatePicker(page: Page, isoDate: string): Promise<void> {
  const formatted = formatDateForPicker(isoDate);
  const dateInput = await findFirstVisibleLocator(page, [
    "#txt_tr_date",
    "input[name='txt_tr_date']",
    "input[id*='txt_tr_date']",
  ]);
  if (!dateInput) return;

  await dateInput.evaluate((el, value) => {
    const input = el as HTMLInputElement;
    const jq = (window as any).jQuery || (window as any).$;
    if (jq) {
      try { jq(input).datepicker("setDate", value); } catch { /* ignore */ }
    }
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }, formatted);

  await page.waitForTimeout(300);
}

async function submitAndKeepOpen(page: Page, modal: Locator): Promise<UiActionResult> {
  const addAnotherButton =
    (await findFirstVisibleLocator(page, [
      "#openTime_AddAn",
      "button#openTime_AddAn",
      "button[id='openTime_AddAn']",
    ])) ?? modal.locator("#openTime_AddAn, button:has-text('Add Time + Another')").first();

  if ((await addAnotherButton.count()) === 0) {
    return {
      success: false,
      error: formatUiError("submit_failed", `'Add Time + Another' button not found. Page URL: ${page.url()}`),
    };
  }

  await addAnotherButton.scrollIntoViewIfNeeded().catch(() => undefined);
  await addAnotherButton.click().catch(async () => {
    await addAnotherButton.click({ force: true }).catch(() => undefined);
  });

  // Wait for the modal to reset (duration input clears)
  await page.waitForTimeout(800);
  return { success: true };
}

type BatchEntryResult = { entry: TimeEntry; success: boolean; error?: string; warning?: string; screenshotPath?: string };

async function addEntriesBatch(page: Page, entries: TimeEntry[], debug: boolean, retries: number): Promise<BatchEntryResult[]> {
  const results: BatchEntryResult[] = [];

  // Open the modal from any available "Add Time" button
  const root = await findTimeRecordingRoot(page);
  const modal = await withRetry(
    retries,
    () => openAddTimeModal(root.locator("body").first(), root, page),
    (result) => result === null,
  );

  if (!modal) {
    const screenshotPath = await captureDebugScreenshot(page, "batch-modal-open-failed", debug);
    const error = formatUiError("add_time_modal_not_found", `Could not open Add Time modal for batch. Page URL: ${page.url()}`);
    return entries.map((entry) => ({ entry, success: false, error, screenshotPath }));
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;

    // Set date via picker
    await fillDatePicker(page, entry.date);

    // Select ticket with retry
    const ticketResult = await withRetry(
      retries,
      () => selectTicket(modal, page, entry.ticketId, entry.description, entry.bookingMode),
      (r) => !r.success,
    );
    if (!ticketResult.success) {
      const screenshotPath = await captureDebugScreenshot(page, `batch-ticket-failed-${i}`, debug);
      results.push({ entry, success: false, error: ticketResult.error, screenshotPath });
      break;
    }

    // Fill duration
    const duration = await findDurationInput(page, modal);
    if (!duration || (await duration.count()) === 0) {
      const screenshotPath = await captureDebugScreenshot(page, `batch-duration-not-found-${i}`, debug);
      results.push({
        entry, success: false, screenshotPath,
        error: formatUiError("submit_failed", `Duration input not found for entry ${i + 1}. Page URL: ${page.url()}`),
      });
      break;
    }
    await duration.fill(formatHourValue(entry.hours));

    // Fill comment (warning only, never abort)
    const commentResult = await fillTinyMceComment(page, modal, entry.description);

    // Snapshot row count before submitting so we can detect duplicates
    const rowCountBefore = await countEntryRows(page, entry).catch(() => 0);

    if (isLast) {
      // Last entry: regular submit + wait for modal close
      const submitResult = await submitAddTimeModal(page, modal);
      if (!submitResult.success) {
        const screenshotPath = await captureDebugScreenshot(page, `batch-submit-failed-${i}`, debug);
        results.push({ entry, success: false, error: submitResult.error, screenshotPath });
        break;
      }
      const modalClosed = await waitForModalToClose(modal, page);
      if (!modalClosed) {
        const validationText = await extractVisibleValidationText(modal);
        const screenshotPath = await captureDebugScreenshot(page, `batch-modal-not-closed-${i}`, debug);
        results.push({
          entry, success: false, screenshotPath,
          error: formatUiError("submit_failed", (validationText ?? "Modal did not close.") + ` | Page URL: ${page.url()}`),
        });
        break;
      }
      await page.waitForTimeout(1000);
      const rowCountAfter = await countEntryRows(page, entry).catch(() => rowCountBefore);
      const newRowAdded = rowCountAfter > rowCountBefore;
      const screenshotPath = await captureDebugScreenshot(page, `batch-success-${i}`, debug);
      const dupWarning = !newRowAdded
        ? formatUiError("entry_row_not_detected", rowCountBefore > 0
            ? `No new row detected — entry for '${entry.ticketId || entry.description}' already existed (${rowCountBefore} match(es) before submit). Possible duplicate rejected by portal.`
            : `No new row detected. Modal closed — verify in TRS.`)
        : undefined;
      const warnings = [commentResult.warning, dupWarning].filter(Boolean).join(" | ");
      results.push({ entry, success: true, warning: warnings || undefined, screenshotPath });
    } else {
      // Non-last entries: click "Add Time + Another" to keep modal open
      const addAnotherResult = await submitAndKeepOpen(page, modal);
      if (!addAnotherResult.success) {
        const screenshotPath = await captureDebugScreenshot(page, `batch-add-another-failed-${i}`, debug);
        results.push({ entry, success: false, error: addAnotherResult.error, screenshotPath });
        break;
      }
      await page.waitForTimeout(500);
      const rowCountAfter = await countEntryRows(page, entry).catch(() => rowCountBefore);
      const newRowAdded = rowCountAfter > rowCountBefore;
      const dupWarning = !newRowAdded
        ? formatUiError("entry_row_not_detected", rowCountBefore > 0
            ? `No new row detected — entry for '${entry.ticketId || entry.description}' already existed (${rowCountBefore} match(es) before submit). Possible duplicate rejected by portal.`
            : `No new row detected after 'Add Time + Another'. Verify in TRS.`)
        : undefined;
      const warnings = [commentResult.warning, dupWarning].filter(Boolean).join(" | ");
      results.push({ entry, success: true, warning: warnings || undefined });
    }
  }

  // Mark any remaining entries as not attempted if we broke early
  for (let i = results.length; i < entries.length; i++) {
    results.push({ entry: entries[i], success: false, error: "Not attempted: an earlier entry in the batch failed." });
  }

  return results;
}

export interface TicketGeneralInfo {
  title: string;
  details: string;
  loggedBy: string;
  clientLocation: string;
  serviceType: string;
  externalId: string;
  clientProject: string;
  reportedBy: string;
  clientContact: string;
  priority: string;
  nextContactDate: string;
  totalTicketTime: string;
}

export interface TicketComment {
  date: string | null;
  commentBy: string;
  context: "Customer facing" | "Internal" | "Work note";
  content: string;
}

export interface TicketTimeEntry {
  date: string;
  user: string;
  durationCON: number;
  durationCUS: number;
  approved: boolean;
}

export interface TicketTimeSummary {
  totalCON: number | "";
  totalCUS: number | "";
  approvedCON: number | "";
  approvedCUS: number | "";
  unapprovedCON: number | "";
  unapprovedCUS: number | "";
  entries: TicketTimeEntry[];
}

export interface TicketWebLink {
  text: string;
  url: string;
}

export interface TicketContext {
  ticketId: string;
  url: string;
  general: TicketGeneralInfo;
  comments: TicketComment[];
  time: TicketTimeSummary;
  webLinks: TicketWebLink[];
  linkedTickets: TicketContext[];
}

async function findTicketFrame(page: Page): Promise<Frame | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const count = await frame.locator("#tabGeneral").count().catch(() => 0);
      if (count > 0) return frame;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

async function extractLinksTabData(ticketFrame: Frame): Promise<{ linkedIds: string[]; webLinks: TicketWebLink[] }> {
  // Tab label includes the count, e.g. "Links (4)" — match loosely
  const linksTab = ticketFrame.locator("[role='tab']").filter({ hasText: /Links/i }).first();
  if ((await linksTab.count()) > 0) {
    await linksTab.click();
    await ticketFrame.locator("#udp_Links_HD").waitFor({ timeout: 10_000 }).catch(() => undefined);
  }

  return ticketFrame.evaluate((): { linkedIds: string[]; webLinks: TicketWebLink[] } => {
    const seen = new Set<string>();
    const TICKET_RE = /^[A-Z]+-\d+$/;

    // Primary: the HD links table — first <td> of each row is the ticket ID text
    const hdLinksTable = document.querySelector("#udp_Links_HD");
    if (hdLinksTable) {
      for (const row of hdLinksTable.querySelectorAll("tbody tr")) {
        const firstCell = row.querySelector("td");
        const text = (firstCell as HTMLElement | null)?.innerText?.trim() ?? "";
        if (TICKET_RE.test(text)) seen.add(text.toUpperCase());
      }
    }

    // Fallback: scan the active panel for any element whose innerText is exactly a ticket ID
    if (seen.size === 0) {
      const root =
        document.querySelector('[role="tabpanel"]:not([aria-hidden="true"])') ?? document;
      for (const el of root.querySelectorAll("td, span, div")) {
        const text = ((el as HTMLElement).innerText ?? "").trim();
        if (TICKET_RE.test(text)) seen.add(text.toUpperCase());
      }
    }

    // Web/document links from #gv_Links_Web — href is "ms-word:ofe|u|<actual_url>"
    const webLinks: TicketWebLink[] = [];
    const webLinksTable = document.querySelector("#gv_Links_Web");
    if (webLinksTable) {
      for (const row of webLinksTable.querySelectorAll("tbody tr")) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 2) continue;
        const linkText = (cells[0] as HTMLElement).innerText.trim();
        const viewAnchor = cells[1]?.querySelector("a[href]") as HTMLAnchorElement | null;
        if (!viewAnchor) continue;
        const rawHref = viewAnchor.getAttribute("href") ?? "";
        // Strip "ms-word:ofe|u|" or similar Office URI prefixes
        const url = rawHref.replace(/^ms-\w+:[^|]*\|u\|/, "");
        if (linkText && url) webLinks.push({ text: linkText, url });
      }
    }

    return { linkedIds: [...seen], webLinks };
  });
}

async function extractSingleTicketContext(
  page: Page,
  ticketId: string,
  baseUrl: string,
  visited: Set<string>,
): Promise<TicketContext> {
  visited.add(ticketId.toUpperCase());
  console.error(`[get_ticket_context] extracting ${ticketId} (visited: ${[...visited].join(", ")})`);

  const ticketUrl = `${baseUrl}/hd/${ticketId}`;
  await page.goto(ticketUrl, { waitUntil: "domcontentloaded" });
  await handleLoginIfNeeded(page, baseUrl);
  if (!page.url().startsWith(ticketUrl)) {
    await page.goto(ticketUrl, { waitUntil: "domcontentloaded" });
  }

  const ticketFrame = await findTicketFrame(page);
  if (!ticketFrame) {
    throw new Error(`Could not find ticket content frame for ${ticketId}. Page URL: ${page.url()}`);
  }

  const general = await ticketFrame.evaluate((): TicketGeneralInfo => {
    function getSelectText(id: string): string {
      const el = document.querySelector(`#${id}`) as HTMLSelectElement | null;
      if (!el || el.selectedIndex < 0) return "";
      return el.options[el.selectedIndex]?.text.trim() ?? "";
    }

    function getInputValue(id: string): string {
      const el = document.querySelector(`#${id}`) as HTMLInputElement | null;
      return el ? el.value.trim() : "";
    }

    function getSpanText(id: string): string {
      const el = document.querySelector(`#${id}`) as HTMLElement | null;
      return el ? el.innerText.trim() : "";
    }

    function cleanHtml(html: string): string {
      return html
        .replace(/<p>/gi, "")
        .replace(/<\/p>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/&nbsp;/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const detailsEl = document.querySelector("#txt_ed_details") as HTMLTextAreaElement | null;
    const rawDetails = detailsEl ? detailsEl.value : "";

    return {
      title: getInputValue("txt_ed_title"),
      details: cleanHtml(rawDetails),
      loggedBy: getSpanText("lbl_ed_logged_by2"),
      clientLocation: getSelectText("ddl_ed_client_loc_id"),
      serviceType: getSelectText("ddl_ed_service_type"),
      externalId: getInputValue("txt_ed_external_id"),
      clientProject: getSelectText("ddl_ed_project_id"),
      reportedBy: getInputValue("txt_ed_reported_by"),
      clientContact: getSelectText("ddl_ed_client_contact"),
      priority: getSelectText("ddl_ed_priority"),
      nextContactDate: getInputValue("txt_next_contact_date"),
      totalTicketTime: getInputValue("txt_ed_quote"),
    };
  });

  const commentsTab = ticketFrame.locator("[role='tab']").filter({ hasText: /^Comments$/i }).first();
  if ((await commentsTab.count()) > 0) {
    await commentsTab.click();
  }
  await ticketFrame.locator("#udp_Comments").waitFor({ timeout: 15_000 }).catch(() => undefined);

  const comments = await ticketFrame.evaluate((): TicketComment[] => {
    const container = document.querySelector("#udp_Comments");
    if (!container) return [];

    return [...container.querySelectorAll("fieldset.mnu_box_page")].map((fs) => {
      const legend = fs.querySelector("legend") as HTMLElement | null;
      let legendText = legend ? legend.innerText.trim() : "";
      legendText = legendText.replace(/\s*Edit Comment.*$/, "").trim();

      const legendMatch = legendText.match(/^(.+?)\s*-\s*([\d/]+\s*[\d:]+)\s*(\((IO|WN)\))?/);

      let commentBy = "";
      let date: string | null = null;
      let commentContext: "Customer facing" | "Internal" | "Work note" = "Customer facing";

      if (legendMatch) {
        commentBy = legendMatch[1].trim();
        date = legendMatch[2].trim();
        commentContext =
          legendMatch[4] === "IO" ? "Internal" :
          legendMatch[4] === "WN" ? "Work note" : "Customer facing";
      }

      const div = fs.querySelector(".cssform") as HTMLElement | null;
      let body = div ? div.innerHTML : "";
      body = body
        .replace(/<p>/gi, "")
        .replace(/<\/p>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/&nbsp;/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return { date, commentBy, context: commentContext, content: body };
    });
  });

  const timeTab = ticketFrame.locator("[role='tab']").filter({ hasText: /^Time$/i }).first();
  if ((await timeTab.count()) > 0) {
    await timeTab.click();
  }
  await ticketFrame.locator("#udp_Time").waitFor({ timeout: 10_000 }).catch(() => undefined);

  const time = await ticketFrame.evaluate((): TicketTimeSummary => {
    function spanNum(id: string): number | "" {
      const el = document.querySelector(`#${id}`) as HTMLElement | null;
      return Number(el?.innerText?.trim()) || "";
    }

    const entries: TicketTimeEntry[] = [];
    const tbody = document.querySelector("#gv_Time tbody");
    if (tbody) {
      for (const row of tbody.querySelectorAll("tr")) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) continue;
        entries.push({
          date: (cells[0] as HTMLElement).innerText.trim(),
          user: (cells[1] as HTMLElement).innerText.trim(),
          durationCON: Number((cells[2] as HTMLElement).innerText.trim()) || 0,
          durationCUS: Number((cells[3] as HTMLElement).innerText.trim()) || 0,
          approved: (cells[4] as HTMLElement)?.innerText?.trim() !== "\u00a0" &&
                    (cells[4] as HTMLElement)?.innerText?.trim() !== "",
        });
      }
    }

    return {
      totalCON: spanNum("lbl_total_time_CON"),
      totalCUS: spanNum("lbl_total_time_CUS"),
      approvedCON: spanNum("lbl_total_time_a_CON"),
      approvedCUS: spanNum("lbl_total_time_a_CUS"),
      unapprovedCON: spanNum("lbl_total_time_u_CON"),
      unapprovedCUS: spanNum("lbl_total_time_u_CUS"),
      entries,
    };
  });

  // Extract linked ticket IDs and web/document links from the Links tab
  const { linkedIds, webLinks } = await extractLinksTabData(ticketFrame);
  console.error(`[get_ticket_context] ${ticketId} → linked: [${linkedIds.join(", ") || "none"}], webLinks: ${webLinks.length}`);

  const linkedTickets: TicketContext[] = [];
  for (const linkedId of linkedIds) {
    if (!visited.has(linkedId.toUpperCase())) {
      const linked = await extractSingleTicketContext(page, linkedId, baseUrl, visited);
      linkedTickets.push(linked);
    } else {
      console.error(`[get_ticket_context] ${ticketId} → skipping ${linkedId} (already visited)`);
    }
  }

  return { ticketId, url: ticketUrl, general, comments, time, webLinks, linkedTickets };
}

export interface WorklistItem {
  priority: string;
  client: string;
  nextSlaDate: string;
  ticketId: string;
  externalId: string;
  title: string;
  type: string;
  nextContactDate: string;
  status: string;
  deliveryDate: string;
  lastComment: string;
  owner: string;
  assignedTo: string;
  project: string;
  module: string;
}

async function findWorklistRoot(page: Page): Promise<InteractionRoot> {
  // Prefer the root that has the reports select
  for (const root of getInteractionRoots(page)) {
    const count = await root.locator("#cphB_ddlReports").count().catch(() => 0);
    if (count > 0) return root;
  }
  return page;
}

export async function getMyWorklistViaUi(options: AutomationOptions = {}): Promise<WorklistItem[]> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const { context, page } = await launchEdge(options);

  try {
    await waitForLogin(page, baseUrl);

    const root = await findWorklistRoot(page);

    // Select "My Worklist" report
    const reportSelect = root.locator("#cphB_ddlReports").first();
    await reportSelect.selectOption("My Worklist");
    await page.waitForTimeout(300);

    // Click Run Report
    const runButton = root.locator("#cphB_butRunReport").first();
    await runButton.click();

    // Wait for the results table to appear
    await page.waitForSelector("#cphB_gv_My_Worklist tbody tr", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle").catch(() => undefined);

    // Extract table data
    const items = await page.evaluate((): WorklistItem[] => {
      const table = document.querySelector("#cphB_gv_My_Worklist");
      if (!table) return [];

      const rows = table.querySelectorAll("tbody tr");
      const results: WorklistItem[] = [];

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 14) continue;

        function cellText(index: number): string {
          const cell = cells[index] as HTMLElement | undefined;
          if (!cell) return "";
          return (cell.innerText ?? "").replace(/\u00a0/g, "").trim();
        }

        // Priority is in a span inside the first cell
        const prioritySpan = cells[0]?.querySelector("span[class*='priority_']") as HTMLElement | null;
        const priority = prioritySpan ? (prioritySpan.innerText ?? "").trim() : cellText(0);

        // Ticket ID is in the anchor link inside the hd_id cell
        const ticketLink = cells[3]?.querySelector("a.dropdown_link") as HTMLElement | null;
        const ticketId = ticketLink ? (ticketLink.innerText ?? "").trim() : cellText(3);

        // Last comment date is in an anchor
        const commentLink = cells[10]?.querySelector("a.comment") as HTMLElement | null;
        const lastComment = commentLink ? (commentLink.innerText ?? "").replace(/\s+/g, " ").trim() : cellText(10);

        results.push({
          priority,
          client: cellText(1),
          nextSlaDate: cellText(2),
          ticketId,
          externalId: cellText(4),
          title: cellText(5),
          type: cellText(6),
          nextContactDate: cellText(7),
          status: cellText(8),
          deliveryDate: cellText(9),
          lastComment,
          owner: cellText(11),
          assignedTo: cellText(12),
          project: cellText(13),
          module: cellText(14),
        });
      }

      return results;
    });

    return items;
  } finally {
    if (!options.keepOpen) {
      await context.close();
    }
  }
}

export async function getTicketContextViaUi(
  ticketId: string,
  options: AutomationOptions = {},
): Promise<TicketContext> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const { context, page } = await launchEdge(options);

  try {
    const visited = new Set<string>();
    return await extractSingleTicketContext(page, ticketId, baseUrl, visited);
  } finally {
    if (!options.keepOpen) {
      await context.close();
    }
  }
}

export async function addTimeEntriesViaUi(
  entries: TimeEntry[],
  options: AutomationOptions = {},
): Promise<{ success: boolean; results: Array<{ entry: TimeEntry; success: boolean; error?: string; warning?: string; screenshotPath?: string }> }> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const debug = options.debug ?? false;
  const retries = Math.max(1, options.retryAttempts ?? 2);

  const { context, page } = await launchEdge(options);
  try {
    await waitForLogin(page, baseUrl);
    await ensureOnEditTimePage(page, baseUrl);

    const results: Array<{ entry: TimeEntry; success: boolean; error?: string; warning?: string; screenshotPath?: string }> =
      entries.length > 1
        ? await addEntriesBatch(page, entries, debug, retries)
        : [{ entry: entries[0], ...(await addEntryToPage(page, entries[0], debug, retries)) }];

    return { success: results.every((r) => r.success), results };
  } finally {
    if (!options.keepOpen) {
      await context.close();
    }
  }
}
