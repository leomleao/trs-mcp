import { promises as fs } from "fs";
import path from "path";
const CUSTOM_ALIAS_FILE = path.join(process.cwd(), "trs-ticket-synonyms.json");
const SEED_MAPPINGS = [
    {
        title: "Support Inbox / Ticket Management 2026",
        ticketCode: "TCTTCT-5687",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-5687",
        typeOfTime: "1. Admin",
        bookingMode: "favourite",
        aliases: [
            "support inbox",
            "inbox",
            "ticket management",
            "support inbox and ticket management",
            "inbox and management",
            "inbox management",
            "triage",
            "ticket triage",
        ],
    },
    {
        title: "Computer updates / Software Installs",
        ticketCode: "TCTTCT-3826",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-3826",
        typeOfTime: "1. Admin",
        bookingMode: "favourite",
        aliases: ["computer updates", "software installs", "software install", "machine setup", "device updates"],
    },
    {
        title: "Internal Departmental Documentation",
        ticketCode: "TCTTCT-4145",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-4145",
        description: "Time booking for writing, reviewing or publishing AMS Documentation",
        typeOfTime: "1. Admin",
        bookingMode: "search",
        aliases: ["documentation", "internal documentation", "departmental documentation", "ams documentation", "docs"],
    },
    {
        title: "Reviewing Company Policies",
        ticketCode: "TCTTCT-3040",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-3040",
        description: "Time for reviewing Company Policies issued by HR",
        typeOfTime: "1. Admin",
        bookingMode: "search",
        aliases: ["company policies", "policy review", "hr policies", "review policies"],
    },
    {
        title: "Open Ticket Review & Management",
        ticketCode: "TCTTCT-1152",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-1152",
        description: "Internal Ticket Review Meetings",
        typeOfTime: "2. Meeting",
        bookingMode: "favourite",
        aliases: ["open ticket review", "ticket review", "review and management", "ticket review meeting"],
    },
    {
        title: "Internal Meetings",
        ticketCode: "TCTTCT-48",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-48",
        description: "Weekly AMS Huddles, Morning/Afternoon Huddles, Monthly Business Updates, Company-wide Updates",
        typeOfTime: "2. Meeting",
        bookingMode: "favourite",
        aliases: [
            "internal meetings",
            "meeting",
            "meetings",
            "huddle",
            "huddles",
            "standup",
            "sync",
            "business update",
            "company update",
        ],
    },
    {
        title: "Mentoring & Coaching",
        ticketCode: "TCTTCT-30",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-30",
        description: "Use this code when you are spending time mentoring or coaching someone or calls with your Buddy for a new starter.",
        typeOfTime: "3. Personal Development",
        bookingMode: "favourite",
        aliases: ["mentoring", "coaching", "buddy call", "mentoring and coaching"],
    },
    {
        title: "Individual led personal development",
        ticketCode: "TCTTCT-3040",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-3040",
        typeOfTime: "3. Personal Development",
        bookingMode: "favourite",
        aliases: ["personal development", "self learning", "individual development", "self study"],
    },
    {
        title: "TCT Learning & Development Courses",
        ticketCode: "TCTTCT-3042",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-3042",
        typeOfTime: "3. Personal Development",
        bookingMode: "search",
        aliases: ["learning and development", "l&d", "ld", "internal course", "training course", "usecure"],
    },
    {
        title: "External-led Training Courses",
        ticketCode: "TCTTCT-555",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-555",
        typeOfTime: "3. Personal Development",
        bookingMode: "search",
        aliases: ["external training", "external course", "sap learning hub", "accreditation"],
    },
    {
        title: "PreBilt Upskilling",
        ticketCode: "TCTTCT-1725",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-1725",
        typeOfTime: "3. Personal Development",
        bookingMode: "search",
        aliases: ["prebilt upskilling", "upskilling"],
    },
    {
        title: "Recruitment",
        ticketCode: "TCTTCT-2930",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-2930",
        typeOfTime: "People Management",
        bookingMode: "search",
        aliases: ["recruitment", "interview", "review cvs", "hiring", "candidate feedback"],
    },
    {
        title: "People Management",
        ticketCode: "TCTTCT-2931",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-2931",
        typeOfTime: "People Management",
        bookingMode: "search",
        aliases: ["people management", "121", "1:1", "line management", "resource planning", "pdr", "approvals"],
    },
    {
        title: "Holiday",
        ticketCode: "TCTTCT-20",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-20",
        typeOfTime: "Time Away",
        bookingMode: "favourite",
        aliases: ["holiday", "annual leave", "vacation"],
    },
    {
        title: "Time in Lieu",
        ticketCode: "TCTTCT-25",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-25",
        typeOfTime: "Time Away",
        bookingMode: "search",
        aliases: ["time in lieu", "toil"],
    },
    {
        title: "Medical Appointment",
        ticketCode: "TCTTCT-55",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-55",
        typeOfTime: "Time Away",
        bookingMode: "search",
        aliases: ["medical appointment", "doctor", "dentist", "hospital", "gp appointment"],
    },
    {
        title: "Birthday Leave",
        ticketCode: "TCTTCT-1708",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-1708",
        typeOfTime: "Time Away",
        bookingMode: "search",
        aliases: ["birthday leave", "birthday"],
    },
    {
        title: "Non-Contract Travel",
        ticketCode: "TCTTCT-36",
        portalUrl: "https://portal.theconfigteam.co.uk/hd/TCTTCT-36",
        typeOfTime: "Travel",
        bookingMode: "search",
        aliases: ["travel", "non-contract travel", "commute for meeting", "journey"],
    },
];
function normalize(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function extractTicketCode(value) {
    const match = value.toUpperCase().match(/\b[A-Z]{3,}-\d+\b/);
    return match ? match[0] : null;
}
async function readCustomAliasStore() {
    try {
        const file = await fs.readFile(CUSTOM_ALIAS_FILE, "utf8");
        const parsed = JSON.parse(file);
        return {
            aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
        };
    }
    catch (error) {
        const nodeError = error;
        if (nodeError.code === "ENOENT") {
            return { aliases: [] };
        }
        throw error;
    }
}
async function writeCustomAliasStore(store) {
    await fs.writeFile(CUSTOM_ALIAS_FILE, JSON.stringify(store, null, 2), "utf8");
}
export async function isKnownAlias(alias) {
    const normalizedAlias = normalize(alias);
    if (!normalizedAlias) {
        return false;
    }
    const seedKnown = SEED_MAPPINGS.some((mapping) => mapping.aliases.some((entry) => normalize(entry) === normalizedAlias) || normalize(mapping.title) === normalizedAlias);
    if (seedKnown) {
        return true;
    }
    const store = await readCustomAliasStore();
    return store.aliases.some((entry) => normalize(entry.alias) === normalizedAlias);
}
export async function listTicketMappings() {
    const store = await readCustomAliasStore();
    return { seeds: SEED_MAPPINGS, customAliases: store.aliases };
}
export async function upsertCustomTicketAlias(alias) {
    const normalizedAlias = normalize(alias.alias);
    const normalizedTicketCode = alias.ticketCode.toUpperCase();
    const store = await readCustomAliasStore();
    const existingIndex = store.aliases.findIndex((entry) => normalize(entry.alias) === normalizedAlias || entry.ticketCode.toUpperCase() === normalizedTicketCode);
    const nextAlias = {
        alias: alias.alias.trim(),
        ticketCode: normalizedTicketCode,
        title: alias.title?.trim(),
        bookingMode: alias.bookingMode,
        notes: alias.notes?.trim(),
    };
    if (existingIndex >= 0) {
        store.aliases[existingIndex] = nextAlias;
    }
    else {
        store.aliases.push(nextAlias);
    }
    await writeCustomAliasStore(store);
    return nextAlias;
}
export async function autoLearnAlias(alias, resolution, notes) {
    const cleanedAlias = alias.trim();
    if (!cleanedAlias) {
        return {
            created: false,
            alias: cleanedAlias,
            ticketCode: resolution.ticketCode,
            bookingMode: resolution.mode,
            title: resolution.title,
        };
    }
    if (await isKnownAlias(cleanedAlias)) {
        return {
            created: false,
            alias: cleanedAlias,
            ticketCode: resolution.ticketCode,
            bookingMode: resolution.mode,
            title: resolution.title,
        };
    }
    const saved = await upsertCustomTicketAlias({
        alias: cleanedAlias,
        ticketCode: resolution.ticketCode,
        bookingMode: resolution.mode,
        title: resolution.title,
        notes,
    });
    return {
        created: true,
        alias: saved.alias,
        ticketCode: saved.ticketCode,
        bookingMode: saved.bookingMode,
        title: saved.title,
    };
}
function scoreMapping(phrase, mapping) {
    const normalizedPhrase = normalize(phrase);
    const candidates = [...mapping.aliases, mapping.title ?? "", mapping.ticketCode];
    let bestScore = 0;
    let matchedAlias;
    for (const candidate of candidates) {
        const normalizedCandidate = normalize(candidate);
        if (!normalizedCandidate) {
            continue;
        }
        let score = 0;
        if (normalizedPhrase === normalizedCandidate) {
            score = 100;
        }
        else if (normalizedPhrase.includes(normalizedCandidate)) {
            score = 80 + Math.min(normalizedCandidate.length, 20);
        }
        else if (normalizedCandidate.includes(normalizedPhrase) && normalizedPhrase.length >= 4) {
            score = 60 + Math.min(normalizedPhrase.length, 20);
        }
        else {
            const phraseTokens = new Set(normalizedPhrase.split(" ").filter(Boolean));
            const candidateTokens = normalizedCandidate.split(" ").filter(Boolean);
            const overlap = candidateTokens.filter((token) => phraseTokens.has(token)).length;
            if (overlap > 0) {
                score = overlap * 15;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            matchedAlias = candidate;
        }
    }
    return { score: bestScore, matchedAlias };
}
export async function resolveBookingSelection(ticketId, description) {
    const explicitTicketCode = extractTicketCode(ticketId) ?? extractTicketCode(description);
    if (explicitTicketCode) {
        return {
            mode: "search",
            ticketCode: explicitTicketCode,
            aliases: [explicitTicketCode],
            confidence: "high",
            matchedAlias: explicitTicketCode,
            source: "explicit_ticket",
        };
    }
    const phrase = `${ticketId} ${description}`.trim();
    if (!phrase) {
        return null;
    }
    const store = await readCustomAliasStore();
    const customMatches = store.aliases
        .map((alias) => {
        const scored = scoreMapping(phrase, { aliases: [alias.alias], title: alias.title, ticketCode: alias.ticketCode });
        return { alias, ...scored };
    })
        .sort((left, right) => right.score - left.score);
    if ((customMatches[0]?.score ?? 0) >= 60) {
        return {
            mode: customMatches[0].alias.bookingMode,
            ticketCode: customMatches[0].alias.ticketCode,
            title: customMatches[0].alias.title,
            aliases: [customMatches[0].alias.alias],
            confidence: customMatches[0].score >= 90 ? "high" : "medium",
            matchedAlias: customMatches[0].matchedAlias,
            source: "custom_alias",
        };
    }
    const seedMatches = SEED_MAPPINGS.map((mapping) => ({ mapping, ...scoreMapping(phrase, mapping) })).sort((left, right) => right.score - left.score);
    if ((seedMatches[0]?.score ?? 0) >= 45) {
        return {
            mode: seedMatches[0].mapping.bookingMode,
            ticketCode: seedMatches[0].mapping.ticketCode,
            title: seedMatches[0].mapping.title,
            aliases: seedMatches[0].mapping.aliases,
            confidence: seedMatches[0].score >= 90 ? "high" : seedMatches[0].score >= 60 ? "medium" : "low",
            matchedAlias: seedMatches[0].matchedAlias,
            source: "seed_mapping",
        };
    }
    return null;
}
