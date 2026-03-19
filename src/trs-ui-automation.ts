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

async function waitForLogin(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

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

async function openAddTimeModal(dayContainer: Locator, root: InteractionRoot, page: Page): Promise<Locator> {
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

  throw new Error(formatUiError("add_time_modal_not_found", "Could not open the Add Time modal."));
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
  await page.waitForTimeout(500);

  const searchInput = await findFirstVisibleLocator(page, [
    "#txt_tr_sch",
    "input[id='txt_tr_sch']",
    "input[name='txt_tr_sch']",
    "input[id*='txt_tr_sch']",
    "input[name*='txt_tr_sch']",
  ]);
  if (!searchInput || (await searchInput.count()) === 0) {
    return {
      success: false,
      error: formatUiError("ticket_picker_not_found", "Search input was not found in the Add Time modal."),
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
      await editorBody.fill(text).catch(() => undefined);
      const bodyText = (await editorBody.innerText().catch(() => "")).trim();
      if (bodyText.toLowerCase().includes(text.toLowerCase())) {
        return { success: true };
      }
    }
  }

  return {
    success: false,
    error: formatUiError("comment_editor_not_found", "TinyMCE comment iframe was not found."),
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

async function detectEntryRow(dayContainer: Locator, entry: TimeEntry): Promise<boolean> {
  const patterns = [entry.ticketId, entry.description];

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = dayContainer.getByText(trimmed, { exact: false }).first();
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      return true;
    }
  }

  const bodyText = (await dayContainer.innerText().catch(() => "")).toLowerCase();
  return patterns.some((pattern) => pattern.trim() && bodyText.includes(pattern.trim().toLowerCase()));
}

async function detectEntryRowAnywhere(page: Page, entry: TimeEntry): Promise<boolean> {
  const patterns = [entry.ticketId, entry.description]
    .map((pattern) => pattern.trim().toLowerCase())
    .filter(Boolean);

  if (patterns.length === 0) {
    return false;
  }

  for (const root of getInteractionRoots(page)) {
    const text = (await root.locator("body").innerText().catch(() => "")).toLowerCase();
    if (patterns.some((pattern) => text.includes(pattern))) {
      return true;
    }
  }

  return false;
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
      error: formatUiError("submit_failed", "Could not find the Add Time submit button."),
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

async function addEntryToPage(page: Page, entry: TimeEntry): Promise<UiActionResult> {
  try {
    const root = await findTimeRecordingRoot(page);
    const { container } = await findDayContext(root, page, entry);
    const datedButton = root.locator(
      [
        `input#cphB_butAdd_${compactDate(entry.date)}[value='Add Time']`,
        `input[name*='$butAdd_${compactDate(entry.date)}'][value='Add Time']`,
      ].join(", "),
    );

    const modal =
      (await (async () => {
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
          return await waitForAddTimeModal(page);
        }
        return null;
      })()) ?? (await openAddTimeModal(container, root, page));

    const ticketResult = await selectTicket(modal, page, entry.ticketId, entry.description, entry.bookingMode);
    if (!ticketResult.success) {
      return ticketResult;
    }

    const duration = await findDurationInput(page, modal);
    if (!duration || (await duration.count()) === 0) {
      return {
        success: false,
        error: formatUiError("submit_failed", "Duration input (#txt_tr_duration) was not found."),
      };
    }
    await duration.fill(formatHourValue(entry.hours));

    const commentResult = await fillTinyMceComment(page, modal, entry.description);
    if (!commentResult.success) {
      return commentResult;
    }

    const submitResult = await submitAddTimeModal(page, modal);
    if (!submitResult.success) {
      return submitResult;
    }

    const modalClosed = await waitForModalToClose(modal, page);
    if (!modalClosed) {
      const validationText = await extractVisibleValidationText(modal);
      return {
        success: false,
        error: formatUiError("submit_failed", validationText ?? "The Add Time modal did not close after submit."),
      };
    }

    await page.waitForTimeout(1500);
    const rowDetectedInDay = await detectEntryRow(container, entry).catch(() => false);
    const rowDetectedAnywhere = rowDetectedInDay ? true : await detectEntryRowAnywhere(page, entry);
    const pageMessages = await extractPageMessages(root).catch(() => undefined);

    if (!rowDetectedAnywhere) {
      return {
        success: false,
        error: formatUiError(
          "entry_row_not_detected",
          pageMessages
            ? `No new row containing '${entry.ticketId || entry.description}' was detected after submit. Visible page messages: ${pageMessages}`
            : `No new row containing '${entry.ticketId || entry.description}' was detected after submit. The modal closed, so please verify in TRS whether the save succeeded.`,
        ),
      };
    }

    return {
      success: true,
      error: pageMessages ? `post_submit_note: ${pageMessages}` : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : formatUiError("submit_failed", String(err)),
    };
  }
}

export async function addTimeEntriesViaUi(
  entries: TimeEntry[],
  options: AutomationOptions = {},
): Promise<{ success: boolean; results: Array<{ entry: TimeEntry; success: boolean; error?: string }> }> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  const { context, page } = await launchEdge(options);
  try {
    await waitForLogin(page, baseUrl);
    await ensureOnEditTimePage(page, baseUrl);

    const results: Array<{ entry: TimeEntry; success: boolean; error?: string }> = [];
    for (const entry of entries) {
      const result = await addEntryToPage(page, entry);
      results.push({ entry, ...result });
    }

    return { success: results.every((r) => r.success), results };
  } finally {
    if (!options.keepOpen) {
      await context.close();
    }
  }
}
