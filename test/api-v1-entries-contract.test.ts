import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function withTenant(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
}

async function secretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function entry(
  identifier: string,
  date: number,
  extra: JsonObject = {},
): JsonObject {
  return {
    identifier,
    date,
    dateString: new Date(date).toISOString(),
    app: "api-v1-contract-test",
    device: "contract-device",
    type: "sgv",
    sgv: 120,
    direction: "Flat",
    ...extra,
  };
}

async function post(tenantName: string, payload: unknown, path = "/api/v1/entries"): Promise<Response> {
  return SELF.fetch(withTenant(path, tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

describe("API v1/v2 Entries uploader and read contract", () => {
  it("matches locked JSON/text/CSV/TSV negotiation, validators, extensions, and HEAD", async () => {
    const name = tenant("v1-format");
    const latest = Math.floor((Date.now() - 60_000) / 1_000) * 1_000;
    const oldest = latest - 60_000;
    expect((await post(name, [
      entry("format-old", oldest, { sgv: 111 }),
      entry("format-new", latest, { sgv: 122 }),
    ])).status).toBe(200);

    const jsonResponse = await SELF.fetch(withTenant("/api/v1/entries.json?count=2", name));
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(jsonResponse.headers.get("Vary")).toBe("Accept");
    expect(jsonResponse.headers.get("Last-Modified")).toBe(new Date(latest).toUTCString());
    const jsonEtag = jsonResponse.headers.get("ETag");
    expect(jsonEtag).toMatch(/^W\/"[0-9a-f]+-[A-Za-z0-9+/]{27}"$/);
    expect((await jsonResponse.json<JsonObject[]>()).map((row) => row.sgv)).toEqual([122, 111]);

    const expectedPlain = [
      `${JSON.stringify(new Date(latest).toISOString())}\t${latest}\t122\t"Flat"\t"contract-device"`,
      `${JSON.stringify(new Date(oldest).toISOString())}\t${oldest}\t111\t"Flat"\t"contract-device"`,
    ].join("\r\n");
    const plain = await SELF.fetch(withTenant("/api/v1/entries?count=2", name));
    expect(plain.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await plain.text()).toBe(expectedPlain);

    const csv = await SELF.fetch(withTenant("/api/v1/entries.csv?count=2", name), {
      headers: { Accept: "application/json" },
    });
    expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const csvLength = csv.headers.get("Content-Length");
    const csvEtag = csv.headers.get("ETag");
    expect(await csv.text()).toBe(expectedPlain.replaceAll("\t", ","));

    for (const [suffix, contentType] of [
      ["tsv", "text/tab-separated-values; charset=utf-8"],
      ["txt", "text/plain; charset=utf-8"],
    ] as const) {
      const response = await SELF.fetch(withTenant(`/api/v2/entries.${suffix}?count=2`, name));
      expect(response.headers.get("Content-Type")).toBe(contentType);
      expect(await response.text()).toBe(expectedPlain);
    }

    const unsupportedAccept = await SELF.fetch(withTenant("/api/v1/entries?count=2", name), {
      headers: { Accept: "application/xml" },
    });
    expect(unsupportedAccept.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await unsupportedAccept.json()).toHaveLength(2);
    const htmlExtension = await SELF.fetch(withTenant("/api/v1/entries.html?count=2", name));
    expect(htmlExtension.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await htmlExtension.json()).toHaveLength(2);
    expect((await SELF.fetch(withTenant("/api/v1/entries.JSON?count=2", name))).status).toBe(404);

    const ims = await SELF.fetch(withTenant("/api/v1/entries.json?count=2", name), {
      headers: {
        "Cache-Control": "no-cache",
        "If-Modified-Since": new Date(latest).toUTCString(),
        "If-None-Match": 'W/"not-the-representation"',
      },
    });
    expect(ims.status).toBe(304);
    expect(await ims.text()).toBe("");
    expect(ims.headers.get("Last-Modified")).toBe(new Date(latest).toUTCString());
    expect(ims.headers.get("ETag")).toBe('W/"39-+ccdCZ3QQbj4krSu1+mUQq9r3as"');
    expect(ims.headers.get("Vary")).toBeNull();

    const inm = await SELF.fetch(withTenant("/api/v1/entries.json?count=2", name), {
      headers: { "If-None-Match": String(jsonEtag) },
    });
    expect(inm.status).toBe(304);
    expect(await inm.text()).toBe("");
    expect(inm.headers.get("ETag")).toBe(jsonEtag);
    expect(inm.headers.get("Vary")).toBe("Accept");

    const head = await SELF.fetch(withTenant("/api/v1/entries.csv?count=2", name), {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(head.headers.get("Last-Modified")).toBe(new Date(latest).toUTCString());
    expect(head.headers.get("Content-Length")).toBe(csvLength);
    expect(head.headers.get("ETag")).toBe(csvEtag);
    expect(head.headers.get("Vary")).toBe("Accept");
    expect(await head.text()).toBe("");

    const emptyName = tenant("v1-format-empty");
    const emptyText = await SELF.fetch(withTenant("/api/v1/entries.txt", emptyName));
    expect(emptyText.status).toBe(200);
    expect(emptyText.headers.get("Last-Modified")).toBeNull();
    expect(await emptyText.text()).toBe("");
  });

  it("applies numeric query coercion and sort-before-limit before final time ordering", async () => {
    const name = tenant("v1-query");
    const base = Math.floor((Date.now() - 30 * 60_000) / 1_000) * 1_000;
    const rows = [
      entry("query-0", base, { sgv: 110, filtered: 1_000, unfiltered: 2_000, rssi: 10, noise: 1 }),
      entry("query-1", base + 60_000, { sgv: 121, filtered: 1_100, unfiltered: 2_100, rssi: 11, noise: 2 }),
      entry("query-2", base + 120_000, { sgv: 132, filtered: 1_200, unfiltered: 2_200, rssi: 12, noise: 3 }),
      entry("query-3", base + 180_000, { sgv: 143, filtered: 1_300, unfiltered: 2_300, rssi: 13, noise: 4 }),
    ];
    expect((await post(name, rows)).status).toBe(200);

    const oldestTwo = await SELF.fetch(withTenant(
      `/api/v1/entries.json?count=2&sort[date]=1&find[date][$gte]=${base}`,
      name,
    ));
    expect((await oldestTwo.json<JsonObject[]>()).map((row) => row.identifier)).toEqual([
      "query-1",
      "query-0",
    ]);

    for (const [field, minimum, expected] of [
      ["sgv", "121junk", [143, 132, 121]],
      ["filtered", "1200", [143, 132]],
      ["unfiltered", "2200", [143, 132]],
      ["rssi", "12", [143, 132]],
      ["noise", "3", [143, 132]],
    ] as const) {
      const response = await SELF.fetch(withTenant(
        `/api/v1/entries.json?count=10&find[${field}][$gte]=${minimum}`,
        name,
      ));
      expect(response.status, field).toBe(200);
      expect((await response.json<JsonObject[]>()).map((row) => row.sgv), field).toEqual(expected);
    }

    const hexCoercion = await SELF.fetch(withTenant(
      "/api/v2/entries.json?count=10&find[sgv][$gte]=0x79",
      name,
    ));
    expect((await hexCoercion.json<JsonObject[]>()).map((row) => row.sgv)).toEqual([143, 132, 121]);
    expect((await SELF.fetch(withTenant(
      "/api/v1/entries.json?find[unsupported]=x",
      name,
    ))).status).toBe(400);
    expect((await SELF.fetch(withTenant(
      "/api/v1/entries.json?sort[unsupported]=1",
      name,
    ))).status).toBe(400);
  });

  it("keeps current/model/ID identity semantics across v1 and inherited v2", async () => {
    const name = tenant("v1-identity");
    const now = Math.floor((Date.now() - 60_000) / 1_000) * 1_000;
    const staleDate = now - 5 * 24 * 60 * 60_000;
    const stale = await post(name, entry("identity-stale", staleDate, { sgv: 101 }));
    const staleId = String((await stale.json<JsonObject[]>())[0]?._id);
    expect(await (await SELF.fetch(withTenant("/api/v1/entries.json", name))).json()).toEqual([]);
    const byQueryId = await SELF.fetch(withTenant(
      `/api/v1/entries.json?find[_id]=${staleId}`,
      name,
    ));
    expect(await byQueryId.json()).toMatchObject([{ _id: staleId, identifier: "identity-stale" }]);

    expect((await post(name, [
      entry("identity-sgv", now, { sgv: 120 }),
      entry("identity-mbg", now + 30_000, {
        type: "mbg",
        sgv: undefined,
        mbg: 133,
        device: "contract-meter",
      }),
    ])).status).toBe(200);
    const current = await SELF.fetch(withTenant("/api/v2/entries/current.json", name));
    expect(await current.json()).toMatchObject([{ identifier: "identity-mbg", type: "mbg", mbg: 133 }]);
    const modelWins = await SELF.fetch(withTenant(
      "/api/v1/entries/mbg.json?find[type]=sgv&count=10",
      name,
    ));
    expect(await modelWins.json()).toMatchObject([{ identifier: "identity-mbg", type: "mbg" }]);

    const upperModel = await SELF.fetch(withTenant(
      `/api/v1/entries/${staleId.toUpperCase()}.json`,
      name,
    ));
    expect(upperModel.status).toBe(200);
    expect(await upperModel.json()).toEqual([]);
    const lowerId = await SELF.fetch(withTenant(`/api/v2/entries/${staleId}.json`, name));
    expect(await lowerId.json()).toMatchObject([{ _id: staleId }]);
  });

  it("commits an ordered batch prefix, stops at the first conflict, and returns Mongo's error envelope", async () => {
    const name = tenant("v1-partial");
    const existingId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const base = Math.floor((Date.now() - 20 * 60_000) / 1_000) * 1_000;
    expect((await post(name, { _id: existingId, ...entry("partial-existing", base) })).status).toBe(200);

    const failed = await post(name, [
      entry("partial-prefix", base + 60_000, { sgv: 121 }),
      { _id: existingId, ...entry("partial-conflict", base + 120_000, { sgv: 122 }) },
      entry("partial-suffix", base + 180_000, { sgv: 123 }),
    ]);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      status: 500,
      message: "Mongo Error",
      description: {},
    });

    const saved = await SELF.fetch(withTenant(
      `/api/v1/entries.json?count=10&find[date][$gte]=${base}`,
      name,
    ));
    const identifiers = (await saved.json<JsonObject[]>()).map((row) => row.identifier);
    expect(identifiers).toEqual(["partial-prefix", "partial-existing"]);
  });

  it("supports preview, recursive upload sanitization, missing array dates, and urlencoded string dates", async () => {
    const previewName = tenant("v1-preview");
    const date = Math.floor((Date.now() - 60_000) / 1_000) * 1_000;
    const dangerous = {
      ...entry("preview-dangerous", date),
      notes: '<img src=x onerror="alert(1)">',
      nested: { label: "Tom & Jerry <script>alert(1)</script>" },
    };
    const unauthorized = await SELF.fetch(withTenant("/api/v1/entries/preview", previewName), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dangerous),
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      status: 401,
      message: "Unauthorized",
      description: "Invalid/Missing",
    });

    const bodyCredentialPreview = await SELF.fetch(
      withTenant("/api/v1/entries/preview", previewName),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...entry("preview-body-credentials", date),
          secret: await secretDigest(),
          token: "selected-invalid-token",
        }),
      },
    );
    expect(bodyCredentialPreview.status).toBe(200);
    const bodyCredentialRows = await bodyCredentialPreview.json<JsonObject[]>();
    expect(bodyCredentialRows).toMatchObject([{ identifier: "preview-body-credentials" }]);
    expect(bodyCredentialRows[0]).not.toHaveProperty("secret");
    expect(bodyCredentialRows[0]).not.toHaveProperty("token");

    const firstArrayCredential = {
      ...entry("preview-array-first", date),
      secret: await secretDigest(),
      token: "selected-invalid-token",
    };
    const laterArrayCredential = {
      ...entry("preview-array-second", date + 1),
      secret: "unselected-second-secret",
      token: "unselected-second-token",
    };
    const arrayCredentialPreview = await SELF.fetch(
      withTenant("/api/v1/entries/preview", previewName),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([firstArrayCredential, laterArrayCredential]),
      },
    );
    const arrayCredentialRows = await arrayCredentialPreview.json<JsonObject[]>();
    expect(arrayCredentialPreview.status).toBe(200);
    expect(arrayCredentialRows[0]).not.toHaveProperty("secret");
    expect(arrayCredentialRows[0]).not.toHaveProperty("token");
    expect(arrayCredentialRows[1]).toMatchObject({
      secret: "unselected-second-secret",
      token: "unselected-second-token",
    });

    const shadowedBodyCredentialPreview = await SELF.fetch(
      withTenant("/api/v1/entries/preview", previewName),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer higher-priority-invalid-token",
          "api-secret": await secretDigest(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...entry("preview-shadowed-credentials", date),
          secret: "unselected-body-secret",
          token: "unselected-body-token",
        }),
      },
    );
    expect(shadowedBodyCredentialPreview.status).toBe(200);
    expect(await shadowedBodyCredentialPreview.json()).toMatchObject([{
      secret: "unselected-body-secret",
      token: "unselected-body-token",
    }]);

    const preview = await post(previewName, dangerous, "/api/v2/entries/preview.csv");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(preview.headers.get("Content-Length")).not.toBeNull();
    expect(preview.headers.get("ETag")).toMatch(/^W\//);
    const previewRows = await preview.json<JsonObject[]>();
    expect(previewRows).toMatchObject([{
      identifier: "preview-dangerous",
      notes: "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
      nested: {
        label: "Tom &amp; Jerry &lt;script&gt;alert(1)&lt;/script&gt;",
      },
    }]);
    const replayPreview = await post(
      previewName,
      {
        ...previewRows[0],
        date: date + 1,
        dateString: new Date(date + 1).toISOString(),
      },
      "/api/v1/entries/preview",
    );
    expect(await replayPreview.json()).toMatchObject([{
      notes: "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
      nested: {
        label: "Tom &amp; Jerry &lt;script&gt;alert(1)&lt;/script&gt;",
      },
    }]);
    expect(await (
      await SELF.fetch(withTenant("/api/v1/entries.json", previewName))
    ).json()).toEqual([]);

    const writeName = tenant("v1-upload-shapes");
    const written = await post(writeName, [
      dangerous,
      { type: "sgv", sgv: 101, direction: "SIDEWAYS", device: "missing-date" },
      entry("low-sgv", date + 60_000, { sgv: 10, direction: "SIDEWAYS" }),
    ]);
    expect(written.status).toBe(200);
    const writtenRows = await written.json<JsonObject[]>();
    expect(writtenRows[0]).toMatchObject({
      notes: "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    });
    expect(writtenRows[1]?.date).toEqual(expect.any(Number));
    expect(writtenRows[1]).toMatchObject({ sgv: 101, direction: "SIDEWAYS" });
    expect(writtenRows[2]).toMatchObject({ sgv: 10, direction: "SIDEWAYS" });

    const formDate = date + 120_000;
    const form = await SELF.fetch(withTenant("/api/v2/entries", writeName), {
      method: "POST",
      headers: {
        "api-secret": await secretDigest(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        date: String(formDate),
        sgv: "119",
        direction: "Flat",
        device: "form-uploader",
      }).toString(),
    });
    expect(form.status).toBe(200);
    expect(await form.json()).toMatchObject([{
      date: formDate,
      sgv: "119",
      device: "form-uploader",
      type: "sgv",
    }]);

    const nestedFormDate = date + 180_000;
    const nestedForm = await SELF.fetch(withTenant("/api/v1/entries", writeName), {
      method: "POST",
      headers: {
        "api-secret": await secretDigest(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: [
        `date=${nestedFormDate}`,
        "sgv=118",
        "direction=Flat",
        "device=form-uploader",
        "meta[source]=nested-form",
        "tags[]=one",
        "tags[]=two",
      ].join("&"),
    });
    expect(nestedForm.status).toBe(200);
    expect(await nestedForm.json()).toMatchObject([{
      date: nestedFormDate,
      meta: { source: "nested-form" },
      tags: ["one", "two"],
    }]);
  });

  it("preserves 100-item order and per-position IDs while bounding the Free-plan batch", async () => {
    const name = tenant("v1-batch-bound");
    const base = Math.floor((Date.now() - 3 * 60 * 60_000) / 1_000) * 1_000;
    const payload = Array.from({ length: 100 }, (_, index) => entry(
      `batch-${index}`,
      base + index * 60_000,
      { sgv: 100 + index },
    ));
    const saved = await post(name, payload);
    expect(saved.status).toBe(200);
    const savedRows = await saved.json<JsonObject[]>();
    expect(savedRows).toHaveLength(100);
    expect(savedRows.map((row) => row.identifier)).toEqual(payload.map((row) => row.identifier));
    expect(savedRows.every((row) => /^[0-9a-f]{24}$/.test(String(row._id)))).toBe(true);

    const tooLarge = await post(name, [...payload, entry("batch-100", base + 100 * 60_000)]);
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toMatchObject({ error: { code: "invalid_batch" } });

    const replayName = tenant("v1-batch-replay");
    const replayDate = Math.floor((Date.now() - 60_000) / 1_000) * 1_000;
    const replay = await post(replayName, [
      entry("replay-first", replayDate, { sgv: 141 }),
      entry("replay-second", replayDate, { sgv: 142 }),
    ]);
    const replayRows = await replay.json<JsonObject[]>();
    expect(replayRows[0]?._id).toMatch(/^[0-9a-f]{24}$/);
    expect(Object.prototype.hasOwnProperty.call(replayRows[1], "_id")).toBe(false);
    const final = await SELF.fetch(withTenant("/api/v1/entries.json", replayName));
    expect(await final.json()).toMatchObject([{ identifier: "replay-second", sgv: 142 }]);

    const invalidIdName = tenant("v1-invalid-id");
    const invalidIdPayload = entry("discarded-helper-identifier", replayDate + 60_000);
    delete invalidIdPayload.identifier;
    const invalidId = await post(invalidIdName, {
      _id: "uploader-owned-id",
      ...invalidIdPayload,
    });
    expect(invalidId.status).toBe(200);
    expect(await invalidId.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      identifier: "uploader-owned-id",
    }]);

    const emptyIdentifier = await post(invalidIdName, {
      _id: "550e8400-e29b-41d4-a716-446655440000",
      ...entry("discarded-empty-identifier", replayDate + 120_000, { identifier: "" }),
    });
    expect(emptyIdentifier.status).toBe(200);
    expect(await emptyIdentifier.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      identifier: "550e8400-e29b-41d4-a716-446655440000",
    }]);
  });

  it("returns a controlled client error when a legal filter shape exceeds SQLite bindings", async () => {
    const name = tenant("v1-query-binding-limit");
    const url = new URL(withTenant("/api/v1/entries.json?count=1", name));
    const fields = [
      "sgv",
      "filtered",
      "unfiltered",
      "rssi",
      "noise",
      "mbg",
      "device",
      "direction",
      "identifier",
      "sysTime",
    ];
    const operators = ["eq", "ne", "gt", "gte", "lt", "lte"];
    for (const field of fields) {
      for (const operator of operators) {
        url.searchParams.set(`find[${field}][$${operator}]`, "1");
      }
    }
    const response = await SELF.fetch(url);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "invalid_query",
        message: expect.stringContaining("bound-parameter limit"),
      },
    });
  });

  it("uses the latest runtime SGV for exact /entries If-Modified-Since and empty results", async () => {
    const name = tenant("v1-context-ims");
    const latest = Math.floor((Date.now() - 60_000) / 1_000) * 1_000;
    expect((await post(name, entry("context-latest", latest, { sgv: 123 }))).status).toBe(200);

    const futureFilter = latest + 60_000;
    const ordinary = await SELF.fetch(withTenant(
      `/api/v1/entries.json?find[date][$gt]=${futureFilter}`,
      name,
    ));
    expect(ordinary.status).toBe(200);
    expect(ordinary.headers.get("Last-Modified")).toBe(new Date(latest).toUTCString());
    expect(await ordinary.json()).toEqual([]);

    const conditional = await SELF.fetch(withTenant(
      `/api/v2/entries.json?find[date][$gt]=${futureFilter}`,
      name,
    ), {
      headers: { "If-Modified-Since": new Date(latest).toUTCString() },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("Last-Modified")).toBe(new Date(latest).toUTCString());
    expect(await conditional.text()).toBe("");
  });
});
