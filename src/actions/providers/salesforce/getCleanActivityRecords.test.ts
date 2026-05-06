import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  buildEmailMessageActivityIdQuery,
  buildEmailMessageQuery,
  buildTaskQuery,
  compareTaskEmailRecords,
  detectTaskDirection,
  normalizeEmailHeaderText,
  normalizeLimit,
  parseExcludeActivityIds,
  soqlQueryAll,
  validateWhereClause,
} from "./getCleanActivityRecords.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGet = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock("../../util/axiosClient.js", () => ({
  axiosClient: { get: (...args: any[]) => mockGet(...args) },
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("salesforceGetCleanActivityRecords Task email chronology", () => {
  test("orders email Task records by available standard sync timestamps", () => {
    const oldEmailSyncedLater = {
      Id: "00T000000000001AAA",
      Subject: "Email: >> Pricing follow-up",
      ActivityDate: "2026-05-06",
      CreatedDate: "2026-05-06T14:00:00.000+0000",
      LastModifiedDate: "2026-05-06T14:00:00.000+0000",
    };
    const newerEmailSyncedEarlier = {
      Id: "00T000000000002AAA",
      Subject: "Email: >> Pricing follow-up",
      ActivityDate: "2026-05-05",
      CreatedDate: "2026-05-05T16:00:00.000+0000",
      LastModifiedDate: "2026-05-07T15:30:00.000+0000",
    };

    const sorted = [oldEmailSyncedLater, newerEmailSyncedEarlier].sort(compareTaskEmailRecords);

    expect(sorted[0]?.Id).toBe("00T000000000002AAA");
  });

  test("does not include package-specific Groove fields in the Task query", () => {
    const soql = buildTaskQuery("WhoId = '003Qp00000cMnCQIA0'", 20);

    expect(soql).toContain("FROM Task WHERE (WhoId = '003Qp00000cMnCQIA0') AND TaskSubtype = 'Email'");
    expect(soql).not.toContain("groove_email_sent_at__c");
  });

  test("detects Task direction from HTML-normalized From header", () => {
    const normalized = normalizeEmailHeaderText("<div>From: John Doe &lt;john@example.com&gt;</div>");

    expect(detectTaskDirection("Email: Follow-up", normalized, "rep@example.com")).toBe("inbound");
    expect(detectTaskDirection("Email: Follow-up", normalized, "john@example.com")).toBe("outbound");
  });
});

describe("salesforceGetCleanActivityRecords EmailMessage exclusions", () => {
  test("builds a separate ActivityId query from the same EmailMessage filter", () => {
    const soql = buildEmailMessageActivityIdQuery("RelatedToId = '500Qp0000012345AAA'");

    expect(soql).toBe(
      "SELECT ActivityId FROM EmailMessage WHERE (RelatedToId = '500Qp0000012345AAA') AND ActivityId != null",
    );
    expect(soql).not.toContain("TextBody");
  });

  test("keeps EmailMessageRelation semi-joins at the top level when date filters are present", () => {
    const whereClause =
      "Id IN (SELECT EmailMessageId FROM EmailMessageRelation WHERE RelationId = '003Qp00000cMnCQIA0') AND MessageDate >= 2026-01-01T00:00:00Z";

    expect(buildEmailMessageQuery(whereClause, 100)).toContain(
      "FROM EmailMessage WHERE Id IN (SELECT EmailMessageId FROM EmailMessageRelation WHERE RelationId = '003Qp00000cMnCQIA0') AND MessageDate >= 2026-01-01T00:00:00Z ORDER BY",
    );
    expect(buildEmailMessageActivityIdQuery(whereClause)).toBe(
      "SELECT ActivityId FROM EmailMessage WHERE Id IN (SELECT EmailMessageId FROM EmailMessageRelation WHERE RelationId = '003Qp00000cMnCQIA0') AND MessageDate >= 2026-01-01T00:00:00Z AND ActivityId != null",
    );
  });

  test("unwraps agent-supplied parentheses around EmailMessageRelation semi-joins", () => {
    const whereClause =
      "(Id IN (SELECT EmailMessageId FROM EmailMessageRelation WHERE RelationId = '003Qp00000cMnCQIA0')) AND MessageDate >= 2026-01-01T00:00:00Z";

    expect(buildEmailMessageQuery(whereClause, 100)).toContain(
      "FROM EmailMessage WHERE Id IN (SELECT EmailMessageId FROM EmailMessageRelation WHERE RelationId = '003Qp00000cMnCQIA0') AND MessageDate >= 2026-01-01T00:00:00Z ORDER BY",
    );
  });

  test("rejects malformed excludeActivityIds JSON", () => {
    expect(() => parseExcludeActivityIds("not-json")).toThrow("excludeActivityIds must be a JSON array string");
  });

  test("rejects non-Salesforce IDs instead of silently dropping them", () => {
    expect(() => parseExcludeActivityIds(JSON.stringify(["00T000000000001AAA", "bad-id"]))).toThrow(
      "excludeActivityIds contains invalid Salesforce IDs: bad-id",
    );
  });

  test("returns valid unique Salesforce IDs", () => {
    expect(parseExcludeActivityIds(JSON.stringify(["00T000000000001AAA", "00T000000000001AAA"]))).toEqual([
      "00T000000000001AAA",
    ]);
  });
});

describe("salesforceGetCleanActivityRecords input guards", () => {
  test("rejects unbalanced parentheses that could break appended filters", () => {
    expect(() => validateWhereClause("1=1) OR (1=1")).toThrow("whereClause contains unbalanced parentheses");
    expect(() => validateWhereClause("Subject LIKE '%(safe)%' AND WhoId = '003Qp00000cMnCQIA0'")).not.toThrow();
  });

  test("floors negative and zero limits at one", () => {
    expect(normalizeLimit(-5)).toBe(1);
    expect(normalizeLimit(0)).toBe(1);
    expect(normalizeLimit(200)).toBe(100);
    expect(normalizeLimit(undefined)).toBe(20);
  });
});

describe("salesforceGetCleanActivityRecords Salesforce query pagination", () => {
  test("follows Salesforce nextRecordsUrl pages up to the requested page cap", async () => {
    mockGet
      .mockResolvedValueOnce({
        data: {
          records: [{ Id: "02sQp0000000001AAA" }],
          done: false,
          nextRecordsUrl: "/services/data/v56.0/query/01gQp0000000001-2000",
        },
      })
      .mockResolvedValueOnce({
        data: {
          records: [{ Id: "02sQp0000000002AAA" }],
          done: false,
          nextRecordsUrl: "/services/data/v56.0/query/01gQp0000000001-4000",
        },
      })
      .mockResolvedValueOnce({
        data: {
          records: [{ Id: "02sQp0000000003AAA" }],
          done: true,
        },
      });

    await expect(
      soqlQueryAll("https://example.my.salesforce.com", "token", "SELECT Id FROM EmailMessage", 2),
    ).resolves.toEqual([{ Id: "02sQp0000000001AAA" }, { Id: "02sQp0000000002AAA" }]);

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[1]?.[0]).toBe(
      "https://example.my.salesforce.com/services/data/v56.0/query/01gQp0000000001-2000",
    );
  });
});
