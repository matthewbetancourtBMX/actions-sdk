# Design: `salesforceGetCleanActivityRecords`

**Date:** 2026-05-05
**Repo:** actions-sdk (fork of credal-ai/actions-sdk)
**Status:** Approved for implementation

---

## Problem

When an agent performs an activity sweep on a Salesforce record, it must currently execute a multi-step manual workflow: probe counts, fetch index data, collect ActivityId exclusion sets, deduplicate by ThreadIdentifier or Subject cluster, and fetch TextBody/Description only for the latest message per thread. This multi-step orchestration is error-prone, token-wasteful, and difficult to get right across all three activity object types (Task, EmailMessage, Event).

Additionally, Task records with `TaskSubtype = 'Email'` contain the full raw email thread in their `Description` field — including headers (To/CC/BCC), quoted reply chains, and signature blocks — which creates significant noise when an agent reads them.

---

## Object Reality in This Org

| Object | Primary context | Relative volume in sales/IMP workflow |
|--------|----------------|---------------------------------------|
| `Task` | Opp/IMP — HubSpot/Groove inbox sync | Dominant |
| `EmailMessage` | Cases (always has `ParentId`); sparse for Opp/IMP | Minority |
| `Event` | Both | Low — always read in full |

When an EmailMessage IS created via email sync, Salesforce auto-generates a mirror Task linked by `EmailMessage.ActivityId = Task.Id`. That Task must be excluded from the Task sweep to prevent double-reading.

---

## Action: `salesforceGetCleanActivityRecords`

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetOrg` | string | Yes | sf CLI org alias |
| `whoId` | string | No* | Contact or Lead ID |
| `whatId` | string | No* | Any related record ID (Opportunity, Case, IMP, Account, etc.) |
| `startDate` | string | No | ISO 8601 date — lower bound on activity date |
| `endDate` | string | No | ISO 8601 date — upper bound on activity date |

\* At least one of `whoId` / `whatId` is required.

The caller passes whatever IDs they have. The action applies them to valid WHERE clause fields per object:
- Task / Event: `WhatId` and/or `WhoId`
- EmailMessage: `RelatedToId` (from `whatId`); EmailMessage has no `WhoId` filter

The agent does not need to know about Salesforce schema differences between objects.

### Execution (sf CLI)

All SOQL queries execute via:
```
sf data query --query "<SOQL>" --json --target-org <targetOrg>
```

Results are parsed from the `--json` output and processed in-process.

---

## Internal Pipeline

### Phase 1 — Probe

Run `COUNT(Id)` queries for all three objects scoped to the provided filters. Include counts in the output so the agent can reason from volume. Never fetch Description or TextBody without first understanding the landscape.

SOQL constraints respected throughout:
- No `GROUP BY Subject` or `GROUP BY ThreadIdentifier` — deduplication is always client-side
- No `TextBody` / `HtmlBody` in WHERE filters
- No nested semi-joins — sequential queries using collected ID sets
- No `LIMIT` or `OFFSET` in subqueries
- `EmailMessage` Step 6 filter uses `WHERE Id IN (...)` only — never `WHERE ThreadIdentifier = ...`

---

### Phase 2 — EmailMessage

1. **Probe** — `COUNT(Id)` scoped to `RelatedToId IN (whatId)`. If zero, note it and skip to Task phase. Emit explicit zero note in output.
2. **Index fetch** — Retrieve: `Id`, `ActivityId`, `MessageIdentifier`, `ThreadIdentifier`, `Subject`, `MessageDate`, `Incoming`, `FromAddress`, `ToAddress`, `CcAddress`. Do **not** fetch `TextBody` yet.
3. **Client-side deduplication** — Deduplicate on `MessageIdentifier`. Group by `ThreadIdentifier`. For each thread: record subject, message count, most recent `MessageDate`, direction of most recent message, and collect the `Id` of the most recent message.
4. **ActivityId exclusion set** — Collect all `ActivityId` values from all returned EmailMessage records. This set is passed to Phase 3 to exclude mirror Tasks.
5. **Thread selection** — Prioritize by recency. Exclude auto-generated subjects (shipping confirmations, system notifications, case auto-replies identified by `Auto-Submitted` header or known noreply patterns).
6. **TextBody fetch** — For selected threads only: `WHERE Id IN (<most recent Id per thread>)`. One fetch per thread maximum. Never filter by `ThreadIdentifier`.
7. **Address surface** — Collect all `FromAddress`, `ToAddress`, `CcAddress` across fetched messages for contact reconciliation.

---

### Phase 3 — Task

1. **Probe** — `COUNT(Id)` scoped to `WhatId` and/or `WhoId` filters with date range. If zero on all filters, note it and skip.
2. **ActivityId exclusion** — Exclude all Task records whose `Id` appears in the ActivityId set from Phase 2. These are auto-generated mirrors of emails already read.
3. **Landscape** — Count by `TaskSubtype` to understand composition before fetching.
4. **Split by TaskSubtype:**

   **`TaskSubtype = 'Email'` (logged email tasks):**
   - Normalize Subject: strip leading `Email:`, `>>`, `Re:`, `Fwd:`, `FW:` prefixes (case-insensitive, repeated)
   - Group remaining tasks by normalized Subject + `WhoId` + `WhatId`
   - For each cluster: identify the most recent record by `groove_email_sent_at__c` (fallback: `LastModifiedDate`)
   - Fetch `Description` only for the most recent Task per cluster
   - **Description cleaning:** Extract only the content before the first quoted-reply marker. Strip:
     - Header block (`From:`, `To:`, `CC:`, `BCC:`, `Attachment:` lines at top)
     - Everything from the first `On <date> <name> wrote:` line onward
     - Trailing signature blocks (heuristic: lines after repeated `\r\n` containing phone/address/social link patterns)
   - Return: cluster subject, owner, cleaned latest message body, sent timestamp, `WhoId`, `WhatId`, cluster size (how many emails in thread)

   **All other `TaskSubtype` values (null, Call, Meeting, etc.):**
   - These are deliberate human activity records — always fetch `Description` in full
   - Never deduplicate or clean — return verbatim

5. **Query scope** — Apply to both `WhatId` and `WhoId` layers. For the `WhoId` layer, cross-reference `WhatId` on returned records to flag any that appear cross-project.

---

### Phase 4 — Event

1. **Probe** — `COUNT(Id)` scoped to `WhatId` and/or `WhoId` filters. Note if zero.
2. **Fetch** — Retrieve all: `Subject`, `StartDateTime`, `EndDateTime`, `DurationInMinutes`, `Owner.Name`, `Description`. Volume is expected low — read Description on all records.
3. **Gong flag** — If any Event Description contains Gong AI-generated content (call summary, transcript, action items, speaker labels, or any text indicating automated call intelligence), flag it explicitly in the output. Do not truncate or summarize Gong content.

---

## Output Structure

```typescript
{
  meta: {
    targetOrg: string;
    filters: { whoId?: string; whatId?: string; startDate?: string; endDate?: string };
    counts: {
      emailMessage: number;
      task: { total: number; emailSubtype: number; nonEmail: number };
      event: number;
    };
    activityIdExclusionCount: number; // Tasks excluded as EmailMessage mirrors
  };

  emailThreads: Array<{
    threadIdentifier: string;
    subject: string;
    messageCount: number;
    mostRecentDate: string;
    direction: 'inbound' | 'outbound'; // direction of most recent message
    latestMessageId: string;
    body: string; // TextBody of most recent message only
    participants: { from: string; to: string; cc?: string };
  }>;

  emailTaskClusters: Array<{
    normalizedSubject: string;
    clusterSize: number; // total Tasks in this thread
    mostRecentDate: string;
    owner: string;
    whoId?: string;
    whatId?: string;
    cleanedBody: string; // Description stripped of headers, quoted content, signatures
  }>;

  nonEmailTasks: Array<{
    id: string;
    taskSubtype: string | null;
    subject: string;
    activityDate?: string;
    owner: string;
    whoId?: string;
    whatId?: string;
    description: string; // verbatim — never cleaned
    isGong: boolean;
  }>;

  events: Array<{
    id: string;
    subject: string;
    startDateTime: string;
    endDateTime: string;
    durationMinutes?: number;
    owner: string;
    description: string;
    isGong: boolean;
  }>;

  summary: {
    lastOutboundDate?: string;
    lastInboundDate?: string;
    openTasks: number;
    zeroResultNotes: string[]; // explicit notes for any object/layer returning zero
  };
}
```

---

## SOQL Constraints Reference

| Constraint | Rule |
|------------|------|
| `GROUP BY Subject` | Invalid on Task and EmailMessage — deduplicate client-side |
| `GROUP BY ThreadIdentifier` | Invalid — deduplicate client-side |
| `TextBody` / `HtmlBody` in WHERE | Invalid |
| Nested semi-joins | Invalid — use sequential queries with collected ID sets |
| `OR` + subquery | Invalid — restructure |
| `LIMIT` / `OFFSET` in subqueries | Invalid |
| EmailMessage Step 6 filter | `WHERE Id IN (...)` only — never `WHERE ThreadIdentifier = ...` |

---

## Implementation Notes

- Runs via `sf data query --query "..." --json --target-org <alias>` for all queries
- No Salesforce-specific npm dependency required — all HTTP handled by sf CLI
- Sequential query pattern: EmailMessage index → ActivityId set → Task exclusion → Task content fetch
- Description cleaning uses regex heuristics for quoted-reply detection (`/^On .+wrote:/m`) and signature block detection
- Action is registered as `type: 'read'` in `actionMapper.ts`
- Schema defined in `schema.yaml`, types regenerated via `npm run generate:types`
- Implementation at `src/actions/providers/salesforce/getCleanActivityRecords.ts`
