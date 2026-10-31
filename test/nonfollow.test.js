const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../nonfollow-core.js");

test("clampCap snaps to known choices", () => {
  assert.equal(core.clampCap(undefined), 2000);
  assert.equal(core.clampCap(2000), 2000);
  assert.equal(core.clampCap(400), 500);
  assert.equal(core.clampCap(99999), 10000);
});

test("diffIds is following minus followers, stable and unique", () => {
  assert.deepEqual(core.diffIds(["1", "2", "2", "3"], new Set(["2"])), ["1", "3"]);
  assert.deepEqual(core.diffIds(["9"], ["9", "8"]), []);
});

test("boolean signal treats missing flag as not mutual, badge uses Follows you", () => {
  const users = [
    { id: "1", followedBy: true },
    { id: "2", followedBy: false },
    { id: "3", followedBy: null },
  ];
  assert.equal(core.signalMode(users), "boolean");
  assert.deepEqual(
    core.selectNonMutual(users, "boolean").map((u) => u.id),
    ["2", "3"]
  );

  const badgeUsers = [
    { id: "a", followedBy: null, followsYouBadge: true, hasSocialSlot: true },
    { id: "b", followedBy: null, followsYouBadge: false, hasSocialSlot: true },
  ];
  assert.equal(core.signalMode(badgeUsers), "badge");
  assert.deepEqual(
    core.selectNonMutual(badgeUsers, "badge").map((u) => u.id),
    ["b"]
  );
  assert.equal(core.signalMode([{ id: "z", followedBy: null }]), "none");
  assert.deepEqual(core.selectNonMutual([{ id: "z" }], "none"), []);
});

test("parseTimelinePage reads users, followed_by, badge, and bottom cursor", () => {
  const json = {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: [
                    {
                      entryId: "user-111",
                      content: {
                        itemContent: {
                          user_results: {
                            result: {
                              __typename: "User",
                              rest_id: "111",
                              relationship_perspectives: { followed_by: false, following: true },
                              legacy: {
                                screen_name: "no_back",
                                name: "未回关",
                                profile_image_url_https: "https://pbs.twimg.com/profile_images/a_normal.jpg",
                                followers_count: 12000,
                              },
                            },
                          },
                          socialContext: { type: "Follow", contextType: "follow", text: "" },
                        },
                      },
                    },
                    {
                      entryId: "user-222",
                      content: {
                        itemContent: {
                          user_results: {
                            result: {
                              __typename: "User",
                              rest_id: "222",
                              core: { screen_name: "yes_back", name: "已回关" },
                              avatar: { image_url: "https://pbs.twimg.com/profile_images/b.jpg" },
                              legacy: { followers_count: 3, protected: true },
                            },
                          },
                          socialContext: { text: "Follows you" },
                        },
                      },
                    },
                    {
                      entryId: "user-333",
                      content: {
                        promotedMetadata: { foo: 1 },
                        itemContent: {
                          user_results: {
                            result: {
                              __typename: "User",
                              rest_id: "333",
                              legacy: { screen_name: "ad", name: "广告" },
                            },
                          },
                        },
                      },
                    },
                    {
                      entryId: "user-444",
                      content: {
                        itemContent: {
                          user_results: { result: { __typename: "UserUnavailable", rest_id: "444" } },
                        },
                      },
                    },
                    {
                      entryId: "cursor-top",
                      content: { entryType: "TimelineTimelineCursor", cursorType: "Top", value: "TOP" },
                    },
                    {
                      entryId: "cursor-bottom",
                      content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "CUR" },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };

  const page = core.parseTimelinePage(json);
  assert.equal(page.cursor, "CUR");
  assert.equal(page.terminated, false);
  assert.deepEqual(
    page.users.map((u) => u.id),
    ["111", "222"]
  );
  const a = page.users[0];
  const b = page.users[1];
  assert.equal(a.followedBy, false);
  assert.equal(a.handle, "no_back");
  assert.equal(a.followersCount, 12000);
  assert.equal(b.handle, "yes_back");
  assert.equal(b.followsYouBadge, true);
  assert.equal(b.protected, true);
  assert.equal(core.signalMode(page.users), "boolean");
  assert.deepEqual(core.selectNonMutual(page.users, "boolean").map((u) => u.handle), ["no_back"]);
});

test("parseTimelinePage stops on terminate and dedupes", () => {
  const page = core.parseTimelinePage({
    data: {
      instructions: [{ type: "TimelineTerminateTimeline" }],
      user: {
        result: {
          __typename: "User",
          rest_id: "9",
          legacy: { screen_name: "solo", name: "S", followers_count: 1 },
        },
      },
    },
  });
  assert.equal(page.terminated, true);
  assert.equal(page.cursor, "");
  assert.equal(page.users.length, 1);
  assert.equal(page.users[0].handle, "solo");
});

test("REST list and ids cursors end at 0", () => {
  const list = core.parseRestListPage({
    users: [
      {
        id_str: "5",
        screen_name: "abc",
        name: "A&B",
        followers_count: 8,
        followed_by: false,
        profile_image_url_https: "http://evil.test/a.jpg",
      },
      { id_str: "6", screen_name: "mutual", name: "M", followed_by: true, connections: ["followed_by"] },
    ],
    next_cursor_str: "0",
  });
  assert.equal(list.terminated, true);
  assert.equal(list.users[0].followedBy, false);
  assert.equal(list.users[0].avatar.startsWith("http:"), false);
  assert.equal(list.users[1].followedBy, true);

  const ids = core.parseRestIdsPage({ ids: ["10", "10", "x", 11], next_cursor_str: "99" });
  assert.deepEqual(ids.ids, ["10", "11"]);
  assert.equal(ids.cursor, "99");
  assert.equal(core.parseRestIdsPage({ ids: [], next_cursor: 0 }).terminated, true);
});

test("empty pages stop after three and do not look like a clean end", () => {
  let streak = 0;
  let decision = { stop: false };
  for (let i = 0; i < 3; i++) {
    decision = core.nextPageDecision("c" + i, { users: [], cursor: "c" + (i + 1) }, streak);
    streak = decision.emptyStreak;
  }
  assert.equal(decision.stop, true);
  assert.equal(decision.reason, "empty_pages");
  assert.equal(decision.truncated, true);
  assert.equal(core.nextPageDecision("same", { users: [{ id: "1" }], cursor: "same" }, 0).reason, "end");
});

test("classify errors and missing features", () => {
  assert.equal(core.classifyXError(429, "{}").code, "rate_limit");
  assert.equal(
    core.classifyXError(401, JSON.stringify({ errors: [{ code: 32, message: "Could not authenticate you" }] })).code,
    "not_logged_in"
  );
  const missing = core.classifyXError(
    400,
    JSON.stringify({
      errors: [{ message: "The following features cannot be null: foo_bar, baz_qux" }],
    })
  );
  assert.equal(missing.code, "missing_features");
  assert.deepEqual(missing.features, ["foo_bar", "baz_qux"]);
  assert.equal(core.classifyXError(404, "nope").code, "not_found");
  assert.equal(core.classifyXError(200, JSON.stringify({ data: { user: {} }, errors: [{ message: "partial" }] })).code, "ok");
  assert.equal(core.classifyXError(200, JSON.stringify({ errors: [{ message: "nope" }] })).code, "api");
});

test("graphql url allowlist rejects mutations and unknown ops", () => {
  const url = core.buildGraphqlUrl(
    "https://x.com",
    "zx6e-TLzRkeDO_a7p4b3JQ",
    "Following",
    core.followingVariables("99", 20, ""),
    { responsive_web_graphql_timeline_navigation_enabled: true, tweet_awards_web_tipping_enabled: false }
  );
  assert.equal(core.isAllowedApiUrl(url, "https://x.com"), true);
  assert.match(decodeURIComponent(url), /includePromotedContent":false/);
  assert.doesNotMatch(decodeURIComponent(url), /tweet_awards/);
  assert.throws(() => core.buildGraphqlUrl("https://x.com", "zx6e-TLzRkeDO_a7p4b3JQ", "CreateTweet", {}, {}));
  assert.equal(
    core.isAllowedApiUrl("https://x.com/i/api/1.1/friendships/destroy.json", "https://x.com"),
    false
  );
  assert.equal(
    core.isAllowedApiUrl("https://x.com/i/api/1.1/friends/ids.json?count=5000", "https://twitter.com"),
    true
  );
  assert.equal(core.isAllowedApiUrl("https://evil.test/i/api/1.1/friends/list.json", "https://x.com"), false);
});

test("storage shape, csv, profile links, and self exclusion", () => {
  const items = core.trimStoredItems([
    { id: "1", handle: "ab", name: "名\n字", avatar: "https://pbs.twimg.com/a.jpg", followersCount: 15000 },
    { id: "1", handle: "dup", name: "x" },
    { id: "bad", handle: "nope", name: "x" },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "名 字");
  const csv = core.toCsv(items);
  assert.match(csv, /^\uFEFF/);
  assert.match(csv, /ab,名 字,15000,https:\/\/x\.com\/ab/);
  assert.equal(core.profileUrl({ id: "42" }), "https://x.com/i/user/42");
  assert.equal(core.formatCount(12000), "1.2万");
  const kept = core.excludeSelf(
    [
      { id: "7", handle: "me" },
      { id: "8", handle: "other" },
    ],
    { id: "7", handle: "me" }
  );
  assert.deepEqual(kept.map((u) => u.id), ["8"]);
  assert.equal(
    core.isStoredResult({ version: 1, scannedAt: 1, items: [] }),
    true
  );
});

test("viewer and lookup parsers", () => {
  const me = core.parseViewer({
    data: {
      viewer: {
        user_results: {
          result: {
            rest_id: "77",
            legacy: { screen_name: "self", name: "自己", friends_count: 10, followers_count: 4 },
          },
        },
      },
    },
  });
  assert.equal(me.handle, "self");
  assert.equal(me.followingCount, 10);
  const looked = core.parseLookupUsers([{ id_str: "3", screen_name: "z", name: "Z", followers_count: 1 }]);
  assert.equal(looked[0].handle, "z");
});

test("shipped scripts stay read-only", () => {
  const root = path.join(__dirname, "..");
  const files = ["nonfollow-core.js", "nonfollow.js", "nonfollow-page.js", "background.js", "content.js"];
  const banned = /friendships\/destroy|friendships\/create|FriendshipsDestroy|FriendshipsCreate|CreateFriendship|DestroyFriendship/i;
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, banned, file);
  }
  const page = fs.readFileSync(path.join(root, "nonfollow-page.js"), "utf8");
  assert.match(page, /method:\s*"GET"/);
  assert.doesNotMatch(page, /method:\s*"POST"/);
});
