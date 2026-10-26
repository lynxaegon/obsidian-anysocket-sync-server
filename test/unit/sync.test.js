const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { storage } = require("../helpers/tmp");
const SyncService = require("../../libs/sync/SyncService");
const { RESULT, sha256 } = SyncService;

const LAPTOP = { id: "laptop-0001", name: "Laptop" };
const PHONE = { id: "phone-00001", name: "iPhone" };

const file = (mtime, action = "created") => ({ type: "file", action, mtime, sha1: null });
const baseOf = (meta) => meta ? { sha1: meta.sha1, action: meta.action } : null;
const text = async (sync, p) => (await sync.content(p)).toString("utf8");

async function setup(t) {
    const env = await storage(t);
    const changes = [];
    const sync = new SyncService(env.storage, { onChange: (paths, device) => changes.push({ paths, device: device.name }) });
    return { ...env, sync, changes };
}

test("a new file is stored, and the content decides its hash", async (t) => {
    const { sync, changes } = await setup(t);
    const r = await sync.put("Notes/a.md", Object.assign(file(1000), { sha1: "client-says-something-else" }), null, "hello", LAPTOP);
    assert.equal(r.result, RESULT.APPLIED);
    assert.equal(r.meta.sha1, sha256("hello"));
    assert.equal(r.meta.device, "Laptop");
    assert.equal(await text(sync, "Notes/a.md"), "hello");
    assert.deepEqual(changes, [{ paths: ["Notes/a.md"], device: "Laptop" }]);
});

test("uploading what the server already has changes nothing", async (t) => {
    const { sync, changes } = await setup(t);
    await sync.put("a.md", file(1000), null, "same", LAPTOP);
    changes.length = 0;
    const r = await sync.put("a.md", file(2000), null, "same", PHONE);
    assert.equal(r.result, RESULT.UNCHANGED);
    assert.equal(changes.length, 0);
});

test("an edit of the current version is applied", async (t) => {
    const { sync } = await setup(t);
    const first = await sync.put("a.md", file(1000), null, "v1", LAPTOP);
    const r = await sync.put("a.md", file(2000), baseOf(first.meta), "v2", PHONE);
    assert.equal(r.result, RESULT.APPLIED);
    assert.equal(await text(sync, "a.md"), "v2");
    assert.deepEqual((await sync.versions("a.md")).data, [2000, 1000]);
});

test("an older edit is applied too when it was made from the current version (no clock games)", async (t) => {
    const { sync } = await setup(t);
    const first = await sync.put("a.md", file(5000), null, "v1", LAPTOP);
    // phone clock is behind, but it edited the current version
    const r = await sync.put("a.md", file(4000), baseOf(first.meta), "v2", PHONE);
    assert.equal(r.result, RESULT.APPLIED);
    assert.equal(await text(sync, "a.md"), "v2");
});

test("edits to different parts of a note are combined", async (t) => {
    const { sync } = await setup(t);
    const base = await sync.put("a.md", file(1000), null, "title\n\nfirst\nsecond\nthird\n", LAPTOP);
    await sync.put("a.md", file(2000), baseOf(base.meta), "title\n\nFIRST from laptop\nsecond\nthird\n", LAPTOP);
    const r = await sync.put("a.md", file(3000), baseOf(base.meta), "title\n\nfirst\nsecond\nTHIRD from phone\n", PHONE);
    assert.equal(r.result, RESULT.MERGED);
    assert.equal(await text(sync, "a.md"), "title\n\nFIRST from laptop\nsecond\nTHIRD from phone\n");
    assert.equal(r.meta.sha1, sha256("title\n\nFIRST from laptop\nsecond\nTHIRD from phone\n"));
    // and the result is a new version, so nothing is lost from history
    assert.equal((await sync.versions("a.md")).data.length, 3);
});

test("edits to the same line keep both versions; the newer one keeps the name", async (t) => {
    const { sync, storage } = await setup(t);
    const base = await sync.put("Folder/a.md", file(1000), null, "line\n", LAPTOP);
    await sync.put("Folder/a.md", file(2000), baseOf(base.meta), "laptop line\n", LAPTOP);
    const r = await sync.put("Folder/a.md", file(3000), baseOf(base.meta), "phone line\n", PHONE);
    assert.equal(r.result, RESULT.KEPT_BOTH);
    assert.equal(await text(sync, "Folder/a.md"), "phone line\n");
    assert.match(r.copy, /^Folder\/a \(Laptop's version, [A-Z][a-z]{2} \d+\)\.md$/);
    assert.equal(await text(sync, r.copy), "laptop line\n");
    assert.equal(storage.index.get(r.copy).device, "Laptop");
});

test("an older conflicting edit becomes the second file, named after its device", async (t) => {
    const { sync } = await setup(t);
    const base = await sync.put("a.md", file(1000), null, "line\n", LAPTOP);
    await sync.put("a.md", file(9000), baseOf(base.meta), "laptop line\n", LAPTOP);
    const r = await sync.put("a.md", file(3000), baseOf(base.meta), "phone line\n", PHONE);
    assert.equal(r.result, RESULT.KEPT_BOTH);
    assert.equal(await text(sync, "a.md"), "laptop line\n");
    assert.match(r.copy, /^a \(iPhone's version, /);
    assert.equal(await text(sync, r.copy), "phone line\n");
});

test("a second conflict on the same day gets its own name", async (t) => {
    const { sync } = await setup(t);
    const base = await sync.put("a.md", file(1000), null, "x\n", LAPTOP);
    await sync.put("a.md", file(9000), baseOf(base.meta), "laptop\n", LAPTOP);
    const one = await sync.put("a.md", file(3000), baseOf(base.meta), "phone 1\n", PHONE);
    const two = await sync.put("a.md", file(4000), baseOf(base.meta), "phone 2\n", PHONE);
    assert.notEqual(one.copy, two.copy);
    assert.match(two.copy, / 2\)\.md$/);
});

test("a device that never synced a file: the newer version wins, the older one goes into the history", async (t) => {
    const { sync, storage } = await setup(t);
    await sync.put("a.md", file(1000), null, "server copy\n", LAPTOP);
    const r = await sync.put("a.md", file(2000), null, "newer local copy\n", PHONE);
    assert.equal(r.result, RESULT.APPLIED);
    assert.equal(await text(sync, "a.md"), "newer local copy\n");
    assert.deepEqual((await sync.versions("a.md")).data, [2000, 1000], "the older one is in the history");
    assert.deepEqual([...storage.index.keys()], ["a.md"], "no second file");
});

test("a device that never synced a file and has an older version gets the newer one; its own goes into the history", async (t) => {
    const { sync, storage, changes } = await setup(t);
    await sync.put("a.md", file(5000), null, "newer on the server\n", LAPTOP);
    changes.length = 0;
    const r = await sync.put("a.md", file(2000), null, "stale on the phone\n", PHONE);
    assert.equal(r.result, RESULT.OUTDATED);
    assert.equal(r.meta.mtime, 5000);
    assert.equal(await text(sync, "a.md"), "newer on the server\n");
    assert.deepEqual((await sync.versions("a.md")).data, [5000, 2000]);
    assert.equal((await sync.content("a.md", 2000)).toString(), "stale on the phone\n");
    assert.deepEqual([...storage.index.keys()], ["a.md"], "no second file");
    assert.equal(changes.length, 0, "nothing changed for the other devices");
});

test("content written by 1.5 with a missing or wrong hash is compared by its bytes (no false conflict)", async (t) => {
    const { sync, storage } = await setup(t);
    // 1.5 left sha1 null after a restore
    await storage.storeEntry("empty.md", { type: "file", action: "created", mtime: 1000, sha1: null, path: "empty.md" }, Buffer.alloc(0));
    await storage.storeEntry("note.md", { type: "file", action: "created", mtime: 1000, sha1: "stale-hash", path: "note.md" }, Buffer.from("same"));
    const empty = await sync.put("empty.md", file(900), null, Buffer.alloc(0), PHONE);
    assert.equal(empty.result, RESULT.UNCHANGED);
    assert.equal(empty.meta.sha1, sha256(Buffer.alloc(0)), "the hash is repaired");
    const note = await sync.put("note.md", file(2000), { sha1: "something-else", action: "created" }, "same", PHONE);
    assert.equal(note.result, RESULT.UNCHANGED);
    assert.equal((await sync.meta("note.md")).sha1, sha256("same"));
    assert.deepEqual([...storage.index.keys()].sort(), ["empty.md", "note.md"]);
});

test("binary files that both changed keep both", async (t) => {
    const { sync } = await setup(t);
    const base = await sync.put("img.png", file(1000), null, Buffer.from([1, 2, 3]), LAPTOP);
    await sync.put("img.png", file(2000), baseOf(base.meta), Buffer.from([4, 5, 6]), LAPTOP);
    const r = await sync.put("img.png", file(3000), baseOf(base.meta), Buffer.from([7, 8, 9]), PHONE);
    assert.equal(r.result, RESULT.KEPT_BOTH);
    assert.deepEqual([...await sync.content("img.png")], [7, 8, 9]);
    assert.deepEqual([...await sync.content(r.copy)], [4, 5, 6]);
});

test("deleting the current version deletes it", async (t) => {
    const { sync } = await setup(t);
    const first = await sync.put("a.md", file(1000), null, "v1", LAPTOP);
    const r = await sync.put("a.md", Object.assign(file(2000, "deleted"), { sha1: first.meta.sha1 }), baseOf(first.meta), null, PHONE);
    assert.equal(r.result, RESULT.APPLIED);
    assert.equal(r.meta.action, "deleted");
    // the content stays in history
    assert.equal((await sync.versions("a.md")).deleted, true);
    assert.equal((await sync.versions("a.md")).data.length, 1);
});

test("deleting a version that was changed elsewhere keeps the newer version", async (t) => {
    const { sync } = await setup(t);
    const first = await sync.put("a.md", file(1000), null, "v1", LAPTOP);
    await sync.put("a.md", file(2000), baseOf(first.meta), "v2 from laptop", LAPTOP);
    const r = await sync.put("a.md", file(9000, "deleted"), baseOf(first.meta), null, PHONE);
    assert.equal(r.result, RESULT.STALE);
    assert.equal(r.meta.action, "created");
    assert.equal(await text(sync, "a.md"), "v2 from laptop");
});

test("an edit of a file deleted elsewhere brings it back", async (t) => {
    const { sync } = await setup(t);
    const first = await sync.put("a.md", file(1000), null, "v1", LAPTOP);
    await sync.put("a.md", file(9000, "deleted"), baseOf(first.meta), null, LAPTOP);
    const r = await sync.put("a.md", file(2000), baseOf(first.meta), "edited on phone", PHONE);
    assert.equal(r.result, RESULT.APPLIED);
    assert.equal(await text(sync, "a.md"), "edited on phone");
});

test("two deletes of the same file are fine", async (t) => {
    const { sync } = await setup(t);
    const first = await sync.put("a.md", file(1000), null, "v1", LAPTOP);
    await sync.put("a.md", file(2000, "deleted"), baseOf(first.meta), null, LAPTOP);
    const r = await sync.put("a.md", file(3000, "deleted"), baseOf(first.meta), null, PHONE);
    assert.equal(r.result, RESULT.UNCHANGED);
});

test("folders are stored without content", async (t) => {
    const { sync } = await setup(t);
    const r = await sync.put("Folder", { type: "folder", action: "created", mtime: 1000 }, null, null, LAPTOP);
    assert.equal(r.result, RESULT.APPLIED);
    assert.equal(r.meta.type, "folder");
    const again = await sync.put("Folder", { type: "folder", action: "created", mtime: 2000 }, null, null, PHONE);
    assert.equal(again.result, RESULT.UNCHANGED);
});

test("bad input is refused", async (t) => {
    const { sync } = await setup(t);
    await assert.rejects(() => sync.put("a.md", file(1000), null, null, LAPTOP), /missing content/);
    await assert.rejects(() => sync.put("a.md", { type: "file", action: "created", mtime: "soon" }, null, "x", LAPTOP), /invalid mtime/);
    await assert.rejects(() => sync.put("a.md", null, null, "x", LAPTOP), /missing metadata/);
});

test("concurrent uploads of the same file never interleave", async (t) => {
    const { sync } = await setup(t);
    const base = await sync.put("a.md", file(1000), null, "a\nb\nc\nd\ne\n", LAPTOP);
    const results = await Promise.all([
        sync.put("a.md", file(2000), baseOf(base.meta), "A\nb\nc\nd\ne\n", LAPTOP),
        sync.put("a.md", file(2001), baseOf(base.meta), "a\nb\nC\nd\ne\n", PHONE),
        sync.put("a.md", file(2002), baseOf(base.meta), "a\nb\nc\nd\nE\n", { id: "tablet-0001", name: "Tablet" })
    ]);
    assert.deepEqual(results.map(r => r.result).sort(), [RESULT.APPLIED, RESULT.MERGED, RESULT.MERGED].sort());
    assert.equal(await text(sync, "a.md"), "A\nb\nC\nd\nE\n");
});

test("a rename moves the history and leaves a pointer behind", async (t) => {
    const { sync, changes } = await setup(t);
    const v1 = await sync.put("old.md", file(1000), null, "v1", LAPTOP);
    const v2 = await sync.put("old.md", file(2000), baseOf(v1.meta), "v2", LAPTOP);
    changes.length = 0;
    const r = await sync.rename("old.md", "Folder/new.md", baseOf(v2.meta), PHONE);
    assert.equal(r.result, RESULT.RENAMED);
    assert.equal(await text(sync, "Folder/new.md"), "v2");
    assert.deepEqual((await sync.versions("Folder/new.md")).data, [2000, 1000]);
    const old = await sync.meta("old.md");
    assert.equal(old.action, "deleted");
    assert.equal(old.renamed_to, "Folder/new.md");
    assert.deepEqual(changes, [{ paths: ["old.md", "Folder/new.md"], device: "iPhone" }]);
});

test("a rename of a file changed elsewhere falls back to delete + create", async (t) => {
    const { sync } = await setup(t);
    const v1 = await sync.put("old.md", file(1000), null, "v1", LAPTOP);
    await sync.put("old.md", file(2000), baseOf(v1.meta), "v2", LAPTOP);
    const r = await sync.rename("old.md", "new.md", baseOf(v1.meta), PHONE);
    assert.equal(r.result, RESULT.FALLBACK);
    assert.equal(await text(sync, "old.md"), "v2");
    assert.equal(await sync.meta("new.md"), null);
});

test("a rename onto an existing file falls back", async (t) => {
    const { sync } = await setup(t);
    const a = await sync.put("a.md", file(1000), null, "a", LAPTOP);
    await sync.put("b.md", file(1000), null, "b", LAPTOP);
    assert.equal((await sync.rename("a.md", "b.md", baseOf(a.meta), PHONE)).result, RESULT.FALLBACK);
    assert.equal((await sync.rename("missing.md", "c.md", baseOf(a.meta), PHONE)).result, RESULT.FALLBACK);
});

test("a rename back onto a deleted path works, and that path's old history stays", async (t) => {
    const { sync } = await setup(t);
    const b = await sync.put("b.md", file(500), null, "old b", LAPTOP);
    await sync.put("b.md", file(600, "deleted"), baseOf(b.meta), null, LAPTOP);
    const a = await sync.put("a.md", file(1000), null, "a", LAPTOP);
    const r = await sync.rename("a.md", "b.md", baseOf(a.meta), PHONE);
    assert.equal(r.result, RESULT.RENAMED);
    assert.equal(await text(sync, "b.md"), "a");
    assert.deepEqual((await sync.versions("b.md")).data, [1000, 500]);
});

test("folder renames move the folder entry only", async (t) => {
    const { sync, storage } = await setup(t);
    const folder = await sync.put("F", { type: "folder", action: "created", mtime: 1000 }, null, null, LAPTOP);
    const child = await sync.put("F/a.md", file(1000), null, "a", LAPTOP);
    const r = await sync.rename("F", "G", baseOf(folder.meta), LAPTOP);
    assert.equal(r.result, RESULT.RENAMED);
    assert.equal(storage.index.get("G").type, "folder");
    // the child is renamed by its own event
    assert.equal(storage.index.get("F/a.md").action, "created");
    assert.equal((await sync.rename("F/a.md", "G/a.md", baseOf(child.meta), LAPTOP)).result, RESULT.RENAMED);
    assert.equal(await text(sync, "G/a.md"), "a");
});

test("list: a full list first, then only what changed", async (t) => {
    const { sync } = await setup(t);
    await sync.put("a.md", file(1000), null, "a", LAPTOP);
    await sync.put("b.md", file(1000), null, "b", LAPTOP);
    const full = sync.list(null, null);
    assert.equal(full.full, true);
    assert.deepEqual(full.entries.map(e => e[0]).sort(), ["a.md", "b.md"]);

    await sync.put("c.md", file(1000), null, "c", LAPTOP);
    const next = sync.list(full.cursor, full.epoch);
    assert.equal(next.full, false);
    assert.deepEqual(next.entries.map(e => e[0]), ["c.md"]);
    assert.deepEqual(sync.list(next.cursor, next.epoch).entries, []);

    // another epoch (server restarted) means a full list again
    assert.equal(sync.list(next.cursor, "another-epoch").full, true);
});

test("files and versions for the history views", async (t) => {
    const { sync } = await setup(t);
    const a = await sync.put("a.md", file(1000), null, "a", LAPTOP);
    await sync.put("b.md", file(1000), null, "b", LAPTOP);
    await sync.put("a.md", file(2000, "deleted"), baseOf(a.meta), null, LAPTOP);
    await sync.put("F", { type: "folder", action: "created", mtime: 1 }, null, null, LAPTOP);
    assert.deepEqual(sync.files("all").map(f => f.path), ["b.md"]);
    assert.deepEqual(sync.files("deleted").map(f => f.path), ["a.md"]);
    assert.deepEqual(await sync.versions("nope.md"), { deleted: false, data: [] });
    assert.equal((await sync.content("a.md", 1000)).toString(), "a");
    assert.equal(await sync.content("a.md", "../../x"), null);
});

test("list: big vaults come in pages, and the pages add up to everything", async (t) => {
    const { sync } = await setup(t);
    for (let i = 0; i < 25; i++) {
        await sync.put("n" + i + ".md", file(1000), null, "note " + i, LAPTOP);
    }
    const seen = new Set();
    let page = sync.list(null, null, 10);
    assert.equal(page.full, true);
    assert.equal(page.entries.length, 10);
    assert.equal(page.more, true);
    page.entries.forEach(e => seen.add(e[0]));
    // a change while paging still shows up
    await sync.put("n0.md", file(2000), baseOf(await sync.meta("n0.md")), "changed", LAPTOP);
    while (page.more) {
        page = sync.list(page.cursor, page.epoch, 10);
        page.entries.forEach(e => seen.add(e[0]));
    }
    assert.equal(seen.size, 25);
    assert.deepEqual(sync.list(page.cursor, page.epoch, 10).entries, []);
});

test("list: entries written by 1.5 (no sequence number) are numbered, so paging still works", async (t) => {
    const { dir } = await setup(t);
    const fs = require("fs");
    for (let i = 0; i < 5; i++) {
        fs.mkdirSync(dir + "/files/old" + i + ".md", { recursive: true });
        fs.writeFileSync(dir + "/files/old" + i + ".md/metadata", JSON.stringify({ action: "created", type: "file", sha1: "x", mtime: 1 }));
        fs.writeFileSync(dir + "/files/old" + i + ".md/1", "x".repeat(i));
    }
    const Storage = require("../../libs/fs/Storage");
    const storage = new Storage(dir + "/files/");
    await storage.init();
    const sync = new SyncService(storage);
    const first = sync.list(null, null, 2);
    const second = sync.list(first.cursor, first.epoch, 2);
    const third = sync.list(second.cursor, second.epoch, 2);
    const all = [...first.entries, ...second.entries, ...third.entries].map(e => e[0]).sort();
    assert.deepEqual(all, ["old0.md", "old1.md", "old2.md", "old3.md", "old4.md"]);
    assert.equal(third.more, false);

    await storage.fillSizes();
    assert.equal(storage.index.get("old3.md").size, 3);
});

test("stored files know their size", async (t) => {
    const { sync } = await setup(t);
    const r = await sync.put("img.png", file(1000), null, Buffer.alloc(12345), LAPTOP);
    assert.equal(r.meta.size, 12345);
});
