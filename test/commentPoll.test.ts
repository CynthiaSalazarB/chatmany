// Regression tests for the comment poll's database load. Every tick re-reads the newest comments on
// each campaign's media, and nearly all of them were handled on an earlier tick. Checking those one
// query at a time makes a tick's work grow with the comments a post collects, on a free tier that
// allows 10ms of CPU per invocation.

import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { pollComments } from "../src/poller/commentPoll";
import { SendQueue } from "../src/queue/queue";
import { isCommentProcessed, markCommentProcessed, upsertCampaign } from "../src/db";
import type { IgComment } from "../src/api/client";
import type { Runtime } from "../src/runtime";
import type { Campaign } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

const campaign: Campaign = {
  campaign_id: "c1",
  name: "Test",
  media_id: "media1",
  keywords: ["Link"],
  exclude: [],
  reward: { type: "link", value: "https://x.com/g" },
  copy: {
    opening: "tap 👇",
    opening_button: "Send it",
    follow_gate: "follow first",
    follow_button: "✅ I followed",
    email_ask: "your email?",
    delivery: "here you go {reward}",
  },
};

// Digits only, like real Instagram ids, so a text-vs-number mismatch in the lookup would show up.
const igComment = (i: number): IgComment => ({
  id: `1784000${i}`,
  text: "Link please",
  from: { id: `900${i}`, username: `user${i}` },
});

const page = (n: number): IgComment[] => Array.from({ length: n }, (_, i) => igComment(i));

function runtime(db: D1Database, comments: IgComment[], client = new FakeClient()): Runtime {
  const queue = new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 });
  return {
    client: { getComments: async () => comments },
    engine: new Engine(db, client.asClient(), queue),
  } as unknown as Runtime;
}

async function seed(comments: IgComment[]): Promise<D1Database> {
  const db = makeTestDb();
  await upsertCampaign(db, campaign, true);
  for (const c of comments) await markCommentProcessed(db, c.id, c.from!.id, "-");
  return db;
}

async function queriesToRepoll(n: number): Promise<number> {
  const comments = page(n);
  const db = await seed(comments);
  const prepare = db.prepare.bind(db);
  let queries = 0;
  db.prepare = (sql: string) => {
    queries++;
    return prepare(sql);
  };
  await pollComments(runtime(db, comments), db);
  return queries;
}

describe("comment poll database load", () => {
  it("re-reading handled comments costs the same however many there are", async () => {
    expect(await queriesToRepoll(50)).toBe(await queriesToRepoll(5));
  });

  it("still answers a new comment among handled ones, and only that one", async () => {
    const db = await seed(page(50));
    const client = new FakeClient();
    const fresh = igComment(50);

    await pollComments(runtime(db, [fresh, ...page(50)], client), db);

    expect(client.calls.privateReply).toHaveLength(1);
    expect(client.calls.privateReply[0]).toMatchObject({ commentId: fresh.id });
    expect(await isCommentProcessed(db, fresh.id)).toBe(true);
  });

  it("retries a comment whose opening failed, on the next poll", async () => {
    const db = await seed([]);
    const client = new FakeClient();
    const c = igComment(0);
    const rt = runtime(db, [c], client);

    client.failNext.privateReply = 1;
    await pollComments(rt, db);
    expect(client.calls.privateReply).toHaveLength(0);
    expect(await isCommentProcessed(db, c.id)).toBe(false);

    await pollComments(rt, db);
    expect(client.calls.privateReply).toHaveLength(1);
    expect(await isCommentProcessed(db, c.id)).toBe(true);
  });
});
