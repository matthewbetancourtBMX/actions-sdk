import type {
  AuthParamsType,
  salesforceGetCleanActivityRecordsFunction,
  salesforceGetCleanActivityRecordsOutputType,
  salesforceGetCleanActivityRecordsParamsType,
} from "../../autogen/types.js";
import { ApiError, axiosClient } from "../../util/axiosClient.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MAX_BODY_LENGTH = 500;
const MAX_ACTIVITY_ID_PAGES = 50;
// Salesforce IDs are 15 or 18 alphanumeric characters — used to validate excludeActivityIds before SOQL interpolation
const SF_ID_PATTERN = /^[a-zA-Z0-9]{15,18}$/;
// Blocks statement terminators and comment sequences that could escape the WHERE clause wrapper
const SOQL_INJECTION_PATTERN = /;|--|\/\*|\*\//;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SfRecord = Record<string, any>;

function forEachSoqlCharacterOutsideString(
  value: string,
  callback: (character: string, index: number) => void | "stop",
): void {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "'" && value[i + 1] === "'") {
        i += 1;
      } else if (character === "'") {
        inString = false;
      }
      continue;
    }

    if (character === "'") {
      inString = true;
      continue;
    }

    if (callback(character, i) === "stop") return;
  }
}

function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  let balanced = true;

  forEachSoqlCharacterOutsideString(value, character => {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) {
      balanced = false;
      return "stop";
    }
    return undefined;
  });

  return balanced && depth === 0;
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, Math.trunc(limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#?\\w+;/g, "");
}

function cleanBody(text: string | null | undefined): string | null {
  if (!text) return null;
  let s = text;
  s = s.replace(/\r\n/g, "\n");
  s = decodeHtmlEntities(s);
  s = s.replace(/<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g, "[$1]");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/^(From|To|CC|BCC|Date|Subject|Attachment):.*\n/gim, "");
  const qm = s.match(/(?:^|\n)(On [\s\S]{0,250}?wrote:\s*(?:\n|$))/);
  if (qm && qm.index !== undefined) {
    const cut = qm.index + (qm[0].startsWith("\n") ? 1 : 0);
    s = s.slice(0, cut);
  }
  s = s.replace(/\n--\s*\n[\s\S]*$/, "");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s.length > 0 ? s : null;
}

function normalizeEmailHeaderText(text: string | null | undefined): string | null {
  if (!text) return null;

  let s = text.replace(/\r\n/g, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, "\n");
  s = decodeHtmlEntities(s);
  s = s.replace(/<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g, "[$1]");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n\s+/g, "\n").trim();

  return s.length > 0 ? s : null;
}

function truncate(text: string | null, maxLength: number): string | null {
  if (!text) return null;
  return text.length <= maxLength ? text : text.slice(0, maxLength) + "…";
}

function normalizeSubject(subject: string): string {
  const prefix = /^(Email:\s*|>>\s*|<<\s*|\[Inbox\]\s*-?\s*|Re:\s*|Fwd?:\s*|FW:\s*)/i;
  let s = subject;
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(prefix, "");
  }
  return s.trim();
}

function parseSalesforceTimestamp(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function getTaskEmailSortKey(record: SfRecord): number {
  const candidates = [
    record.Email_Sent_At__c,
    record.EmailDate__c,
    record.LastModifiedDate,
    record.CreatedDate,
    record.ActivityDate,
  ];

  for (const candidate of candidates) {
    const parsed = parseSalesforceTimestamp(candidate);
    if (parsed !== Number.NEGATIVE_INFINITY) return parsed;
  }

  return Number.NEGATIVE_INFINITY;
}

function compareTaskEmailRecords(a: SfRecord, b: SfRecord): number {
  const byEmailTime = getTaskEmailSortKey(b) - getTaskEmailSortKey(a);
  if (byEmailTime !== 0) return byEmailTime;
  return String(b.Id ?? "").localeCompare(String(a.Id ?? ""));
}

function formatTaskEmailDate(record: SfRecord): string | null {
  const candidates = [
    record.Email_Sent_At__c,
    record.EmailDate__c,
    record.LastModifiedDate,
    record.CreatedDate,
    record.ActivityDate,
  ];
  return (candidates.find(value => typeof value === "string" && value.length > 0) as string | undefined) ?? null;
}

function detectTaskDirection(
  subject: string,
  description: string | null | undefined,
  ownerEmail: string | null | undefined,
): "inbound" | "outbound" | "unknown" {
  if (subject.includes(">>")) return "outbound";
  if (subject.includes("<<") || /\[inbox\]/i.test(subject)) return "inbound";
  if (description && ownerEmail) {
    const fromMatch =
      description.match(/^From:\s*.*?\[([^\]]+@[^\]]+)\]/im) ||
      description.match(/^From:\s*.*?<([^>]+)>/im) ||
      description.match(/^From:\s*(\S+@\S+)/im);
    if (fromMatch) {
      const fromEmail = fromMatch[1].trim().replace(/[>,;]+$/, "").toLowerCase();
      return fromEmail === ownerEmail.toLowerCase() ? "outbound" : "inbound";
    }
  }
  return "unknown";
}

function parseExcludeActivityIds(excludeActivityIds?: string): string[] {
  if (!excludeActivityIds) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(excludeActivityIds);
  } catch {
    throw new Error("excludeActivityIds must be a JSON array string");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("excludeActivityIds must be a JSON array string");
  }

  const invalid = parsed.filter(id => typeof id !== "string" || !SF_ID_PATTERN.test(id));
  if (invalid.length > 0) {
    throw new Error(`excludeActivityIds contains invalid Salesforce IDs: ${invalid.join(", ")}`);
  }

  return [...new Set(parsed as string[])];
}

// whereClause is provided by an AI agent and is NOT treated as untrusted end-user input. This guard
// blocks comment sequences and statement terminators that could break the WHERE clause wrapping and
// allow unintended record access. Hallucinated or malformed SOQL that passes this check returns a
// Salesforce API error surfaced to the caller.
function validateWhereClause(whereClause: string): void {
  if (SOQL_INJECTION_PATTERN.test(whereClause)) {
    throw new Error(
      "whereClause contains disallowed patterns (;  --  /*  */). Provide a plain SOQL filter expression without statement terminators or comment sequences. " +
        "Example: \"WhatId = '001Qp000003abcDEF' AND ActivityDate >= 2024-01-01\"",
    );
  }
  if (!hasBalancedParentheses(whereClause)) {
    throw new Error(
      "whereClause contains unbalanced parentheses. Provide a balanced SOQL filter expression that cannot escape appended safety filters. " +
        "Example: \"(WhatId = '001Qp000003abcDEF' OR WhoId = '003Qp000003abcDEF') AND ActivityDate >= 2024-01-01\"",
    );
  }
}

async function soqlQuery(baseUrl: string, authToken: string, soql: string): Promise<unknown[]> {
  const url = `${baseUrl}/services/data/v56.0/query?q=${encodeURIComponent(soql)}`;
  const response = await axiosClient.get(url, { headers: { Authorization: `Bearer ${authToken}` } });
  return response.data.records ?? [];
}

// Follows Salesforce nextRecordsUrl pagination up to maxPages to avoid unbounded requests on large orgs.
async function soqlQueryAll(baseUrl: string, authToken: string, soql: string, maxPages: number): Promise<unknown[]> {
  const headers = { Authorization: `Bearer ${authToken}` };
  let url: string | null = `${baseUrl}/services/data/v56.0/query?q=${encodeURIComponent(soql)}`;
  const all: unknown[] = [];
  let pages = 0;
  while (url && pages < maxPages) {
    const response = await axiosClient.get(url, { headers });
    const data = response.data as { records?: unknown[]; done?: boolean; nextRecordsUrl?: string };
    all.push(...(data.records ?? []));
    url = data.done === false && data.nextRecordsUrl ? `${baseUrl}${data.nextRecordsUrl}` : null;
    pages += 1;
  }
  return all;
}

function buildTaskQuery(whereClause: string, limit: number, exclusionIds: string[] = []): string {
  const exclusion = exclusionIds.length > 0 ? ` AND Id NOT IN (${exclusionIds.map(id => `'${id}'`).join(",")})` : "";
  return `SELECT Id, Subject, TaskSubtype, ActivityDate, CreatedDate, LastModifiedDate, Owner.Name, Owner.Email, WhoId, WhatId, Description FROM Task WHERE (${whereClause}) AND TaskSubtype = 'Email'${exclusion} ORDER BY LastModifiedDate DESC NULLS LAST LIMIT ${
    limit + 1
  }`;
}

async function handleTask(
  baseUrl: string,
  authToken: string,
  whereClause: string,
  limit: number,
  maxBodyLength: number,
  excludeActivityIds?: string,
): Promise<salesforceGetCleanActivityRecordsOutputType> {
  validateWhereClause(whereClause);
  const exclusionIds = parseExcludeActivityIds(excludeActivityIds);
  // Fetch limit+1 to determine whether additional records exist without relying on Salesforce pagination metadata.
  // The Task query intentionally avoids package-specific fields such as groove_email_sent_at__c so the action works in standard Salesforce orgs.
  const soql = buildTaskQuery(whereClause, limit, exclusionIds);
  const rawRecords = (await soqlQuery(baseUrl, authToken, soql)) as SfRecord[];
  const hasMore = rawRecords.length > limit;
  const records = hasMore ? rawRecords.slice(0, limit) : rawRecords;

  // Group by normalizedSubject + WhoId + WhatId
  const threadMap = new Map<string, SfRecord[]>();
  for (const r of records) {
    const key = `${normalizeSubject(r.Subject ?? "")}||${r.WhoId ?? ""}||${r.WhatId ?? ""}`;
    const group = threadMap.get(key) ?? [];
    group.push(r);
    threadMap.set(key, group);
  }

  // Resolve WhoId → Contact, then Lead as fallback
  const whoIds = [...new Set(records.map(r => r.WhoId).filter(Boolean) as string[])];
  const contactMap = new Map<string, { id: string; name: string; email: string | null; title: string | null }>();
  if (whoIds.length > 0) {
    const idList = whoIds.map(id => `'${id}'`).join(",");
    const contactSoql = `SELECT Id, Name, Email, Title FROM Contact WHERE Id IN (${idList})`;
    const contacts = (await soqlQuery(baseUrl, authToken, contactSoql)) as SfRecord[];
    for (const c of contacts) {
      contactMap.set(c.Id, { id: c.Id, name: c.Name, email: c.Email ?? null, title: c.Title ?? null });
    }
    const unresolvedIds = whoIds.filter(id => !contactMap.has(id));
    if (unresolvedIds.length > 0) {
      const leadIdList = unresolvedIds.map(id => `'${id}'`).join(",");
      const leadSoql = `SELECT Id, Name, Email, Title FROM Lead WHERE Id IN (${leadIdList})`;
      const leads = (await soqlQuery(baseUrl, authToken, leadSoql)) as SfRecord[];
      for (const l of leads) {
        contactMap.set(l.Id, { id: l.Id, name: l.Name, email: l.Email ?? null, title: l.Title ?? null });
      }
    }
  }

  const threads = [];
  for (const [, group] of threadMap) {
    group.sort(compareTaskEmailRecords);
    const latest = group[0];
    const ownerEmail: string | null = latest.Owner?.Email ?? null;
    const cleanedDescription = cleanBody(latest.Description);
    const directionDescription = normalizeEmailHeaderText(latest.Description);
    threads.push({
      normalizedSubject: normalizeSubject(latest.Subject ?? ""),
      threadSize: group.length,
      latestDate: formatTaskEmailDate(latest),
      activityDate: latest.ActivityDate ?? null,
      direction: detectTaskDirection(latest.Subject ?? "", directionDescription, ownerEmail),
      owner: latest.Owner?.Name ?? null,
      whoId: latest.WhoId ?? null,
      whatId: latest.WhatId ?? null,
      contact: latest.WhoId ? (contactMap.get(latest.WhoId) ?? null) : null,
      latestTaskId: latest.Id,
      allTaskIds: group.map(r => r.Id as string),
      cleanedDescription: truncate(cleanedDescription, maxBodyLength),
    });
  }

  threads.sort((a, b) => {
    if (!a.latestDate) return 1;
    if (!b.latestDate) return -1;
    return b.latestDate.localeCompare(a.latestDate);
  });

  return {
    success: true,
    objectType: "Task",
    totalFetched: records.length,
    totalThreads: threads.length,
    threads,
    ...(hasMore && {
      hasMore: true,
      hasMoreMessage: `Result set was capped at ${limit} records (${threads.length} threads shown). There may be additional Task activity not included in this response. Narrow your WHERE clause or increase the limit parameter to retrieve more.`,
    }),
  };
}

function containsSemiJoinSubquery(whereClause: string): boolean {
  return /\b(?:NOT\s+)?IN\s*\(\s*SELECT\b/i.test(whereClause);
}

function unwrapParenthesizedSemiJoins(whereClause: string): string {
  let normalized = whereClause;
  let previous: string;

  do {
    previous = normalized;
    normalized = normalized.replace(/\(\s*([A-Za-z_][\w.]*\s+(?:NOT\s+)?IN\s*\(\s*SELECT\b[^)]*\))\s*\)/gi, "$1");
  } while (normalized !== previous);

  return normalized;
}

function formatEmailMessageWhereClause(whereClause: string): string {
  return containsSemiJoinSubquery(whereClause) ? unwrapParenthesizedSemiJoins(whereClause) : `(${whereClause})`;
}

function buildEmailMessageActivityIdQuery(whereClause: string): string {
  return `SELECT ActivityId FROM EmailMessage WHERE ${formatEmailMessageWhereClause(whereClause)} AND ActivityId != null`;
}

function buildEmailMessageQuery(whereClause: string, limit: number): string {
  return `SELECT Id, Subject, MessageDate, Incoming, FromAddress, ToAddress, CcAddress, TextBody, ThreadIdentifier, MessageIdentifier, RelatedToId, ActivityId FROM EmailMessage WHERE ${formatEmailMessageWhereClause(
    whereClause,
  )} ORDER BY MessageDate DESC NULLS LAST LIMIT ${limit + 1}`;
}

async function collectCompleteEmailMessageActivityIds(
  baseUrl: string,
  authToken: string,
  whereClause: string,
): Promise<string[]> {
  const rows = (await soqlQueryAll(
    baseUrl,
    authToken,
    buildEmailMessageActivityIdQuery(whereClause),
    MAX_ACTIVITY_ID_PAGES,
  )) as SfRecord[];
  return [
    ...new Set(rows.map(row => row.ActivityId).filter((id): id is string => typeof id === "string" && id.length > 0)),
  ];
}

async function handleEmailMessage(
  baseUrl: string,
  authToken: string,
  whereClause: string,
  limit: number,
  maxBodyLength: number,
  returnActivityIds?: boolean,
): Promise<salesforceGetCleanActivityRecordsOutputType> {
  validateWhereClause(whereClause);
  // Fetch limit+1 to determine whether additional records exist without relying on Salesforce pagination metadata
  const soql = buildEmailMessageQuery(whereClause, limit);
  const rawRecords = (await soqlQuery(baseUrl, authToken, soql)) as SfRecord[];
  const hasMore = rawRecords.length > limit;
  const records = hasMore ? rawRecords.slice(0, limit) : rawRecords;

  const threadMap = new Map<string, SfRecord[]>();
  for (const r of records) {
    const key = r.ThreadIdentifier ?? r.Id;
    const group = threadMap.get(key) ?? [];
    group.push(r);
    threadMap.set(key, group);
  }

  const threads = [];
  for (const [threadIdentifier, group] of threadMap) {
    group.sort((a, b) => {
      if (!a.MessageDate) return 1;
      if (!b.MessageDate) return -1;
      return b.MessageDate.localeCompare(a.MessageDate);
    });
    const latest = group[0];
    threads.push({
      threadIdentifier,
      normalizedSubject: normalizeSubject(latest.Subject ?? ""),
      threadSize: group.length,
      latestDate: latest.MessageDate ?? null,
      direction: latest.Incoming === true ? "inbound" : "outbound",
      relatedToId: latest.RelatedToId ?? null,
      fromAddress: latest.FromAddress ?? null,
      toAddress: latest.ToAddress ?? null,
      latestMessageId: latest.Id,
      allMessageIds: group.map(r => r.Id as string),
      messageIdentifiers: group.map(r => r.MessageIdentifier as string).filter(Boolean),
      cleanedBody: truncate(cleanBody(latest.TextBody), maxBodyLength),
    });
  }

  threads.sort((a, b) => {
    if (!a.latestDate) return 1;
    if (!b.latestDate) return -1;
    return b.latestDate.localeCompare(a.latestDate);
  });

  const result: salesforceGetCleanActivityRecordsOutputType = {
    success: true,
    objectType: "EmailMessage",
    totalFetched: records.length,
    totalThreads: threads.length,
    threads,
    ...(hasMore && {
      hasMore: true,
      hasMoreMessage: `Result set was capped at ${limit} records (${threads.length} threads shown). There may be additional EmailMessage activity not included in this response. Narrow your WHERE clause or increase the limit parameter to retrieve more.`,
    }),
  };

  if (returnActivityIds) {
    result.activityIds = JSON.stringify(await collectCompleteEmailMessageActivityIds(baseUrl, authToken, whereClause));
  }

  return result;
}

const getCleanActivityRecords: salesforceGetCleanActivityRecordsFunction = async ({
  params,
  authParams,
}: {
  params: salesforceGetCleanActivityRecordsParamsType;
  authParams: AuthParamsType;
}): Promise<salesforceGetCleanActivityRecordsOutputType> => {
  const { authToken, baseUrl } = authParams;
  const { objectType, whereClause, limit, maxBodyLength, returnActivityIds, excludeActivityIds } = params;

  if (!authToken || !baseUrl) {
    return { success: false, error: "authToken and baseUrl are required for Salesforce API" };
  }

  const effectiveLimit = normalizeLimit(limit);
  const effectiveMaxBodyLength = maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;

  try {
    if (objectType === "Task")
      return await handleTask(
        baseUrl,
        authToken,
        whereClause,
        effectiveLimit,
        effectiveMaxBodyLength,
        excludeActivityIds,
      );
    return await handleEmailMessage(
      baseUrl,
      authToken,
      whereClause,
      effectiveLimit,
      effectiveMaxBodyLength,
      returnActivityIds,
    );
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof ApiError
          ? error.data?.length > 0
            ? error.data[0].message
            : error.message
          : error instanceof Error
            ? error.message
            : "An unknown error occurred",
    };
  }
};

export {
  buildEmailMessageActivityIdQuery,
  buildEmailMessageQuery,
  buildTaskQuery,
  cleanBody,
  collectCompleteEmailMessageActivityIds,
  compareTaskEmailRecords,
  detectTaskDirection,
  getTaskEmailSortKey,
  normalizeEmailHeaderText,
  normalizeLimit,
  normalizeSubject,
  parseExcludeActivityIds,
  soqlQueryAll,
  validateWhereClause,
};

export default getCleanActivityRecords;
