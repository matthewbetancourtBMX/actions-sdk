import { describe, expect, test } from "@jest/globals";
import {
  buildEmailMessageActivityIdQuery,
  buildEmailMessageQuery,
  compareTaskEmailRecords,
  parseExcludeActivityIds,
} from "./getCleanActivityRecords.js";

describe("salesforceGetCleanActivityRecords Task email chronology", () => {
  test("orders email Task records by actual sent timestamp before manual sync timestamp", () => {
    const oldEmailSyncedLater = {
      Id: "00T000000000001AAA",
      Subject: "Email: >> Pricing follow-up",
      ActivityDate: "2026-05-06",
      groove_email_sent_at__c: "2026-04-01T09:00:00.000+0000",
      CreatedDate: "2026-05-06T14:00:00.000+0000",
      LastModifiedDate: "2026-05-06T14:00:00.000+0000",
    };
    const newerEmailSyncedEarlier = {
      Id: "00T000000000002AAA",
      Subject: "Email: >> Pricing follow-up",
      ActivityDate: "2026-05-05",
      groove_email_sent_at__c: "2026-05-05T15:30:00.000+0000",
      CreatedDate: "2026-05-05T16:00:00.000+0000",
      LastModifiedDate: "2026-05-05T16:00:00.000+0000",
    };

    const sorted = [oldEmailSyncedLater, newerEmailSyncedEarlier].sort(compareTaskEmailRecords);

    expect(sorted[0]?.Id).toBe("00T000000000002AAA");
  });
});

describe("salesforceGetCleanActivityRecords EmailMessage exclusions", () => {
  test("builds a separate uncapped ActivityId query from the same EmailMessage filter", () => {
    const soql = buildEmailMessageActivityIdQuery("RelatedToId = '500Qp0000012345AAA'");

    expect(soql).toBe(
      "SELECT ActivityId FROM EmailMessage WHERE (RelatedToId = '500Qp0000012345AAA') AND ActivityId != null",
    );
    expect(soql).not.toContain("LIMIT");
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
