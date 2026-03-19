console.log("in-page.js loaded");

window.ticketData = window.ticketData || {
	lastComment: "",
	personName: "",
	previousToLastCommentDate: "",
	nextContactDate: "",
	lbl_total_time_CON: "",
	lbl_total_time_CUS: "",
	txt_ed_quote: ""
};


// ------------------------------------------
// Utility: wait for an element to appear
// ------------------------------------------
function waitForElement(selector, root = document) {
	return new Promise(resolve => {
		const existing = root.querySelector(selector);
		if (existing) return resolve(existing);

		const observer = new MutationObserver(() => {
			const found = root.querySelector(selector);
			if (found) {
				observer.disconnect();
				resolve(found);
			}
		});

		observer.observe(root, { childList: true, subtree: true });
	});
}

/**
 * Get the latest customer-facing comment (context === "Customer facing")
 * @param {Array} comments - Array of comment objects, latest first
 * @returns {Object|null} - The comment object, or null if none found
 */
function getLastCustomerFacingComment(comments) {
	for (const comment of comments) {
		if (comment.context === "Customer facing") {
			return comment;
		}
	}
	return null;
}

/**
 * Get the comment before the latest customer-facing comment
 * @param {Array} comments - Array of comment objects, latest first
 * @returns {Object|null} - The comment object, or null if none found
 */
function getPreviousToLastCustomerFacingComment(comments) {
	let foundLatest = false;

	for (const comment of comments) {
		if (comment.context === "Customer facing") {
			if (!foundLatest) {
				// First customer-facing comment → mark as found
				foundLatest = true;
			} else {
				// Second customer-facing comment → return it
				return comment;
			}
		}
	}
	return null;
}


// ------------------------------------------
// Utility: prepareCommentsForSummarizer
// ------------------------------------------
function prepareCommentsForSummarizer(comments) {
	return comments.map((c, index) => {
		const dateStr = c.date ? new Date(c.date).toLocaleString('en-GB', {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}) : "Unknown date";

		return `Comment ${index + 1} (${c.context}) by ${c.commentBy} on ${dateStr}:\n${c.content}\n`;
	}).join("\n---\n");
}

// ------------------------------------------
// Utility: template filler
// ------------------------------------------
function fillTemplate(template, data = {}) {
	return template.replace(/{{\s*([^}]+)\s*}}/g, (match, key) => {
		key = key.trim();

		// Handle function calls such as todayPlusDays(3)
		const functionCall = key.match(/^(\w+)\((.*?)\)$/);
		if (functionCall) {
			const funcName = functionCall[1];
			const arg = functionCall[2];

			if (funcName === "todayPlusDays") {
				const days = parseInt(arg);
				const d = new Date();
				d.setDate(d.getDate() + days);
				return d.toLocaleDateString('en-GB'); // DD/MM/YYYY
			}
		}

		// Normal variable replacement
		if (key in data) {
			let value = data[key];

			// Special handling for personName
			if (key === "personName" && typeof value === "string") {
				const emailMatch = value.match(/([a-zA-Z0-9._%+-]+@eviosys\.[a-zA-Z]{2,})/);
				if (emailMatch) {
					return `@[${emailMatch[1]}]`;
				}
			}

			return value;
		}

		return match; // fallback if key not found
	});
}

// ------------------------------------------
// Utility: Button factory
// ------------------------------------------

function createTemplateButton(label, id, template) {
	const button = document.createElement("button");
	button.id = id;
	button.type = "button";
	button.className = "ui-button ui-corner-all ui-widget";
	button.textContent = label;

	button.addEventListener("click", () => {
		const result = fillTemplate(template, window.ticketData);

		const iframe = findElement("#txt_ed_comment_ifr");
		if (!iframe) return null;

		const doc = iframe.contentDocument || iframe.contentWindow.document;
		if (!doc) return null;

		const tiny = doc.querySelector("#tinymce");
		if (!tiny) {
			alert("TinyMCE not found.");
			return;
		}

		tiny.innerHTML = result;
	});

	return button;
}

function createSingleLineSummaryButton(label, id) {
	const button = document.createElement("button");
	button.id = id;
	button.type = "button";
	button.className = "ui-button ui-corner-all ui-widget";
	button.textContent = label;

	button.addEventListener("click", async () => {
		const iframe = findElement("#txt_ed_comment_ifr");
		if (!iframe) return null;

		const doc = iframe.contentDocument || iframe.contentWindow.document;
		if (!doc) return null;

		const tiny = doc.querySelector("#tinymce");
		if (!tiny) {
			alert("TinyMCE not found.");
			return;
		}

		currentComment = tiny.innerHTML;

		// -------------------------
		// 1. Generate single-line summary
		// -------------------------
		const summaryField = findElement("#txt_tr_comments");
		if (!summaryField) return;

		try {
			let singleLineSummary = "";
			const hasPromptAPI = typeof LanguageModel !== "undefined";

			if (hasPromptAPI) {
				const availability = await LanguageModel.availability();
				if (availability === "available") {
					const session = await LanguageModel.create({
						initialPrompts: [
							{
								role: "system",
								content: `
								You are an assistant that summarizes user comments for display in a web interface.
								Output exactly one concise sentence in text. You're infering what was done based on the comment.
								Do not add extra text, explanations, or numbering.
								Focus on the main point or action implied by the comments.
								Keep it clear, professional, and self-contained.
								`.trim()
							}
						]
					});

					const prompt = [
						{
							role: "user",
							content: `
							Summarize the work carried out based on the comment. 
							It will justify the time spent on this piece of work in the timesheet.					
							Comment:
							${currentComment}
									`.trim()
						}
					];

					singleLineSummary = await session.prompt(prompt);
				}
			}

			// Fallback if PromptAI is not available
			if (!singleLineSummary) {
				console.log("Single line summary falls back to summarizer")

				const summarizer = await Summarizer.create({
					sharedContext: "Summarize comments into a single sentence.",
					type: "tldr",
					length: "short",
					expectedInputLanguages: ["en-GB"],
					outputLanguage: "en-GB"
				});
				const singleLineSummary = await summarizerSession.summarize(textToBeSummarized);

				summaryField.value = singleLineSummary;
			}


			// -------------------------
			// 2. Optional: Estimate duration using Prompt AI
			// -------------------------
			const durationField = findElement("#txt_tr_duration");
			if (durationField && hasPromptAPI) {
				try {
					const session = await LanguageModel.create({
						initialPrompts: [
							{
								role: "system",
								content: `
								You are an assistant that estimates the total effort required for a task based on user comments.
								Output only a numeric value representing hours, using increments of 0.25 (e.g., 0.25, 0.5, 0.75, 1, 1.25).
								Do not include any text, units, or explanations—only the number.
								If unsure, round up to the nearest 0.25.
								Focus on all the comments provided to determine the total time.
								`.trim()
							}
						]
					});

					const prompt = [
						{
							role: "user",
							content: `Estimate the total hours it would take to complete the following task based on the comments: \n\n${currentComment}`
						}
					];

					
					let duration = await session.prompt(prompt);
					console.log("Estimated time from ai:" + duration)

					// Normalize duration to increments of 0.25
					duration = parseFloat(duration);
					if (isNaN(duration) || duration <= 0) duration = 1;
					duration = Math.round(duration * 4) / 4;

					durationField.value = duration;
				} catch (err) {
					console.warn("Failed to estimate duration:", err);
				}
			}

		} catch (err) {
			alert("Failed to generate summary.");
			console.error(err);
		}
	});

	return button;
}

// ------------------------------------------
// Utility: to add the button to comment screen
// ------------------------------------------
function addTemplateButtons(container, templates) {
	// Prevent duplicates
	if (document.getElementById("first-strike")) return;

	const btn1 = createSingleLineSummaryButton("Fill time", "single-line-summary");
	const btn2 = createTemplateButton("3rd Strike", "first-strike", templates.template1);
	const btn3 = createTemplateButton("2nd Strike", "second-strike", templates.template2);
	const btn4 = createTemplateButton("Closure", "closure", templates.template3);

	container.appendChild(btn1);
	container.appendChild(btn2);
	container.appendChild(btn3);
	container.appendChild(btn4);
}

// ------------------------------------------
// Utility: Coversion to UL and LI tags
// ------------------------------------------
function convertTextToList(text) {
	// Utility function to escape HTML special characters
	function escapeHtml(str) {
		return str
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	// Split strictly by " - " (space-hyphen-space) only, not single hyphens inside words
	const items = text
		.split('- ')
		.map(item => item.trim())
		.filter(item => item !== '');

	// Wrap each item in <li> with escaped content
	const listItems = items.map(item => `<li>${escapeHtml(item)}</li>`).join('');

	// Wrap everything in <ul>
	return `<br>Key Points:<br><ul>${listItems}</ul>`;
}

// ------------------------------------------
// Find the document containing #udp_Comments
// ------------------------------------------
function findElement(query, root = document) {

	// 1. Try root document
	const found = root.querySelector(query);
	if (found) return found;

	// 2. Scan iframes recursively
	const iframes = root.querySelectorAll("iframe");
	for (const frame of iframes) {
		try {
			const doc = frame.contentDocument || frame.contentWindow.document;
			if (!doc) continue;

			const result = findElement(query, doc);
			if (result) return result;

		} catch (e) {
		}
	}

	return null;
}

// ------------------------------------------
// Extract comment text
// ------------------------------------------

function extractComments(container) {
	const comments = [...container.querySelectorAll('fieldset.mnu_box_page')];

	return comments.map(fs => {
		// --- Extract the legend text ---
		const legend = fs.querySelector('legend');
		let legendText = legend ? legend.innerText.trim() : "";

		// Remove "Edit" or images
		legendText = legendText.replace(/\s*Edit Comment.*$/, "").trim();
		// --- Parse legend for name and date ---
		// Example legend: "Eviosys API User - 05/12/2025 17:13:11 (WN)"
		// const legendMatch = legendText.match(/^(.+?)\s*-\s*(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/);
		const legendMatch = legendText.match(/^(.+?)\s*-\s*([\d/]+\s*[\d:]+)\s*(\((IO|WN)\))?/);
		// const commentBy = legendMatch ? legendMatch[1].trim() : "";
		let commentBy = "", date = null, context = "Customer facing";;

		// if (legendMatch) {
		// 	const dateStr = legendMatch[2].trim(); // "DD/MM/YYYY HH:MM:SS"
		// 	const [day, month, yearAndTime] = dateStr.split('/');
		// 	const [year, time] = [yearAndTime.slice(0, 4), yearAndTime.slice(5) || ""];
		// 	const [hours, minutes, seconds] = time.split(':').map(Number);
		// 	date = new Date(Number(year), Number(month) - 1, Number(day), hours, minutes, seconds);
		// }

		if (legendMatch) {
			commentBy = legendMatch[1].trim();
			const dateStr = legendMatch[2].trim(); // "DD/MM/YYYY HH:MM:SS"
			const [day, month, yearAndTime] = dateStr.split('/');
			const [year, time] = [yearAndTime.slice(0, 4), yearAndTime.slice(5) || ""];
			const [hours, minutes, seconds] = time.split(':').map(Number);
			date = new Date(Number(year), Number(month) - 1, Number(day), hours, minutes, seconds);
			context = legendMatch[4] === "IO" ? "Internal" :
				legendMatch[4] === "WN" ? "Work note" : "Customer facing";
		}

		// --- Extract the comment body ---
		const div = fs.querySelector('.cssform');
		let body = div ? div.innerHTML : "";

		// Convert <br> and <p> to proper newlines and clean HTML
		body = body
			.replace(/<p>/gi, "")
			.replace(/<\/p>/gi, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/&nbsp;/g, " ")
			.replace(/<[^>]+>/g, "")          // remove remaining HTML tags
			.replace(/\n{3,}/g, "\n\n")       // trim excessive line breaks
			.trim();

		return {
			date,
			commentBy,
			context,
			content: body
		};
	});
}

// ------------------------------------------
// Creates the "summary box" UI
// ------------------------------------------
function insertSummaryBox(targetFieldset) {
	const wrapper = document.createElement("div");
	wrapper.style.position = "relative";

	wrapper.innerHTML = `
    <style>
		.loader {
		width: 50px;
		aspect-ratio: 1;
		display: grid;
		border: 4px solid #0000;
		border-radius: 50%;
		border-right-color: #020089;
		animation: l15 1s infinite linear;
		margin-left: 20%;
		}
		.loader::before,
		.loader::after {
		content: "";
		grid-area: 1/1;
		margin: 2px;
		border: inherit;
		border-radius: 50%;
		animation: l15 2s infinite;
		}
		.loader::after {
		margin: 8px;
		animation-duration: 3s;
		}
		@keyframes l15{
		100%{transform: rotate(1turn)}
		}

		#ai-summary-box {
		display: flex;
		align-items: center;
		}
	
		.loader-text {
		font-family: Tahoma, Arial;
		font-size: 1.2em;
		color: #333333;
		text-align: center;
		margin-top: 10%;
		}
    </style>

    <fieldset class="mnu_box_page">
        <legend>Internal AI generated summary of comments</legend>
        <div class="cssform">
            <div id="ai-summary-box">
                <div class="loader-container">
                    <div class="loader"></div>
                    <div class="loader-text">Loading summary…</div>
                </div>
            </div>
			<div id="ai-key-points">                
            </div>
        </div>
    </fieldset>
`;
	// Insert right after the legend inside the target fieldset
	const fieldset = targetFieldset.querySelector("fieldset");
	fieldset.insertAdjacentElement("beforebegin", wrapper);

	return {
		summaryBox: wrapper.querySelector("#ai-summary-box"),
		keyPoints: wrapper.querySelector("#ai-key-points")
	}
}


async function init() {
	console.log("Initializing extension…");
	initUI();            // Your Extract & Summarise feature
	try {
		url = chrome.runtime.getURL('templates.json');
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const templates = await res.json();
		watchCommentEditor(templates);
	} catch (e) {
		console.error('Could not load templates', e);
	}
}
init();



// window.addEventListener('click', evt => {
// 	console.info(evt);	
// }, {
// 	capture: false,
// });

async function initUI() {
	console.log("Waiting for .ui-dialog…");

	const dialog = await waitForElement(".ui-dialog");
	const buttonBar = await waitForElement(".ui-dialog-buttonset", dialog);

	if (document.getElementById("extract-btn")) return;

	const newButton = document.createElement("button");
	newButton.id = "extract-btn";
	newButton.type = "button";
	newButton.className = "ui-button ui-corner-all ui-widget";
	newButton.textContent = "Extract & Summarise Comments";

	newButton.addEventListener("click", onExtractCommentsClick);

	buttonBar.firstElementChild.insertAdjacentElement("beforebegin", newButton);

	console.log("Extract+Summarise button added.");

	refreshTicketData(dialog);
}

async function onExtractCommentsClick() {
	console.log("Extract & Summarise comments clicked");

	const summary = findElement("#ai-summary-box");
	if (summary) {
		console.info("AI summary already present, no need to add another one.");
		return;
	}

	const commentSection = findElement("#udp_Comments");
	if (!commentSection) {
		console.info("Could not find udp_Comments. onExtractCommentsClick");
		return;
	}

	const comments = extractComments(commentSection);
	if (!comments.length) {
		console.info("No comments found. onExtractCommentsClick");
		return;
	}

	const inputForAI = prepareCommentsForSummarizer(comments);

	const summaryElements = insertSummaryBox(commentSection);
	const summaryBox = summaryElements.summaryBox;
	const keyPointsBox = summaryElements.keyPoints;

	await generateSummary(inputForAI, summaryBox);
	await generateKeyPoints(inputForAI, keyPointsBox);
}

// ---------------------------
// Generate summary
// ---------------------------
async function generateSummary(input, summaryBox) {
	try {
		// 1. Check if Prompt API is available
		const hasPromptAPI = typeof LanguageModel !== "undefined";
		let usedPromptAPI = false;

		if (hasPromptAPI) {
			try {
				// Check model availability
				const availability = await LanguageModel.availability();
				if (availability === "available") {
					usedPromptAPI = true;

					// Create a session with a system prompt for summarization
					const session = await LanguageModel.create({
						initialPrompts: [
							{
								role: "system",
								content: "You are an assistant that summarizes user comments for display in a web interface.Avoid unnecessary text. Focus on the main points and latest updates. Keep it concise. You are a helpful assistant."
							}
						]
					});

					// Run prompting for summary
					const prompt = [
						{
							role: "user",
							content: `Summarize the following user comments into paragraphs, focusing on main points and latest updates:\n\n${input}`
						}
					];

					const stream = session.promptStreaming(prompt);

					await typewriterUpdate(stream, summaryBox, 5);

				}
			} catch (err) {
				console.warn("Prompt API available but failed:", err);
				usedPromptAPI = false;
			}
		}

		// 2. Fallback to existing Summarizer if Prompt API not used
		if (!usedPromptAPI) {
			// Insert fallback indicator
			summaryBox.textContent = "Generating summary...";

			const summarizer = await Summarizer.create({
				sharedContext:
					"A general summary of what the comments have discussed so far, emphasizing the latest status.",
				type: "tldr",
				length: "short",
				expectedInputLanguages: ["en-GB"],
				outputLanguage: "en-GB",
			});

			const stream = await summarizer.summarizeStreaming(input);

			// Show streaming output
			await typewriterUpdate(stream, summaryBox, 5);
		}
	} catch (err) {
		summaryBox.textContent = "Failed to generate summary.";
		console.error("Summariser error:", err);
	}
}

// ---------------------------
// Generate key points
// ---------------------------
async function generateKeyPoints(input, keyPointsBox) {
	try {
		const summarizer = await Summarizer.create({
			sharedContext:
				"A list of key-points of how the comments have evolved, from the latest to earliest.",
			type: "key-points",
			length: "medium",
			expectedInputLanguages: ["en-GB"],
			outputLanguage: "en-GB",
		});

		const keyPoints = await summarizer.summarize(input);
		keyPointsBox.innerHTML = convertTextToList(keyPoints);
	} catch (err) {
		keyPointsBox.innerHTML = "Failed to generate key points.";
		console.error("Summariser error:", err);
	}
}

// ------------------------------------------
// Refresh ticket data
// ------------------------------------------
async function refreshTicketData(dialog) {

	console.log("Ticket opened → refreshing ticketData");
	const ticketDoc = findElement("#tblHDID", dialog)
	console.log(ticketDoc);
	const commentSection = findElement("#udp_Comments", dialog);
	if (!commentSection) {
		console.info("Could not find udp_Comments. refreshTicketData");
		return;
	}
	// 2. Extract comments
	const comments = extractComments(commentSection);
	const lastCommentObj = getLastCustomerFacingComment(comments);
	const prevCommentObj = getPreviousToLastCustomerFacingComment(comments);

	// Reset object
	window.ticketData.personName = "";
	window.ticketData.lastComment = "";
	window.ticketData.lastCommentDate = "";
	window.ticketData.previousToLastCommentDate = "";
	window.ticketData.nextContactDate = "";
	window.ticketData.totalTimeCON = "";
	window.ticketData.totalTimeCUS = "";
	window.ticketData.totalTicketTime = "";

	// Fill using selectors (replace your own criteria)
	window.ticketData.personName = ticketDoc.querySelector("#txt_ed_reported_by").value.trim() || "";
	window.ticketData.lastComment = lastCommentObj?.content ?? "";
	window.ticketData.lastCommentDate = lastCommentObj?.date ? new Date(lastCommentObj.date).toLocaleDateString("en-GB") : "";
	window.ticketData.previousToLastCommentDate = ticketData.previousToLastCommentDate = prevCommentObj?.date ? new Date(prevCommentObj.date).toLocaleDateString("en-GB"): "";
	window.ticketData.nextContactDate = ticketDoc.querySelector("#txt_next_contact_date").value.trim() || "";
	window.ticketData.totalTimeCON = Number(ticketDoc.querySelector("#lbl_total_time_CON").innerText) || "";
	window.ticketData.totalTimeCUS = Number(ticketDoc.querySelector("#lbl_total_time_CUS").innerText) || "";
	window.ticketData.totalTicketTime = ticketDoc.querySelector("#txt_ed_quote").value || "";

	console.log("ticketData updated:", window.ticketData);

}

async function watchCommentEditor(templates) {
	while (true) {
		const editor = await waitForElement("#divEditHDEntryComment_IO");

		addTemplateButtons(editor, templates);

		// short sleep to avoid duplicate button injection
		await new Promise(r => setTimeout(r, 2000));
	}
}

async function typewriterUpdate(stream, Element, delay = 20) {
	let aiText = "";

	for await (const chunk of stream) {
		// Add each character individually
		for (const char of chunk) {
			aiText += char;
			Element.textContent = aiText;
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}
}


