const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpdir, storage } = require("../helpers/tmp");
const Helpers = require("../../libs/helpers");
const { merge, copyPath, isMergeable, sanitize } = require("../../libs/sync/merge");
const Backup = require("../../libs/Backup");

test("paths: only vault-relative paths are accepted", () => {
    for (const ok of ["a.md", "Folder/Sub/b.md", "Notes/my file (1).md", "x/.hidden", "日本/ノート.md"]) {
        assert.equal(Helpers.isSafePath(ok), true, ok);
    }
    for (const bad of ["", "/etc/passwd", "\\x", "C:/x", "c:\\x", "../x", "a/../../x", "a/./b", "a\\..\\b",
        "a/metadata", "metadata/x", "a\0b", null, 5, {}]) {
        assert.equal(Helpers.isSafePath(bad), false, String(bad));
    }
});

test("merge: changes on different lines are combined", () => {
    assert.equal(merge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"), "A\nb\nC\n");
    assert.equal(merge("a\n", "a\nmine\n", "theirs\na\n"), "theirs\na\nmine\n");
});

test("merge: the same line changed both ways is not combined", () => {
    assert.equal(merge("a\nb\n", "A1\nb\n", "A2\nb\n"), null);
});

test("merge: trivial cases", () => {
    assert.equal(merge("x", "x", "y"), "y");
    assert.equal(merge("x", "y", "x"), "y");
    assert.equal(merge("x", "z", "z"), "z");
    assert.equal(merge("", "", ""), "");
});

test("merge: only plain text", () => {
    assert.equal(isMergeable("a.md"), true);
    assert.equal(isMergeable("Folder/a.TXT"), true);
    assert.equal(isMergeable("a.canvas"), false);
    assert.equal(isMergeable("a.json"), false);
    assert.equal(isMergeable("README"), false);
});

test("copy names are readable and valid file names", () => {
    const time = new Date(2026, 9, 26, 12).getTime();
    assert.equal(copyPath("Folder/Note.md", "iPhone", time, () => false), "Folder/Note (iPhone's version, Oct 26).md");
    assert.equal(copyPath("Note", "Mac", time, () => false), "Note (Mac's version, Oct 26)");
    assert.equal(copyPath("a.b.md", "x", time, () => false), "a.b (x's version, Oct 26).md");
    const taken = new Set(["N (x's version, Oct 26).md", "N (x's version, Oct 26 2).md"]);
    assert.equal(copyPath("N.md", "x", time, p => taken.has(p)), "N (x's version, Oct 26 3).md");
    assert.equal(sanitize('My: "Phone" [1] #a|b'), "My Phone 1 ab");
    assert.equal(copyPath("N.md", "///", time, () => false), "N (Another device's version, Oct 26).md");
    assert.ok(Helpers.isSafePath(copyPath("F/N.md", "../../evil", time, () => false)));
});

test("backup: data is copied once before a new version runs", (t) => {
    const dir = tmpdir(t, "backup");
    fs.mkdirSync(path.join(dir, "files", "a.md"), { recursive: true });
    fs.writeFileSync(path.join(dir, "files", "a.md", "metadata"), "{}");
    fs.mkdirSync(path.join(dir, "db"));
    fs.writeFileSync(path.join(dir, "db", "data.json"), "{}");

    const target = Backup.beforeUpgrade(dir, "1.6.0");
    assert.ok(target);
    assert.ok(fs.existsSync(path.join(target, "files", "a.md", "metadata")));
    assert.ok(fs.existsSync(path.join(target, "db", "data.json")));
    assert.equal(Backup.beforeUpgrade(dir, "1.6.0"), null, "only once");
    assert.ok(Backup.beforeUpgrade(dir, "1.7.0"), "again for the next version");
});

test("backup: nothing to back up on a fresh server", (t) => {
    const dir = tmpdir(t, "backup");
    assert.equal(Backup.beforeUpgrade(dir, "1.6.0"), null);
    assert.equal(Backup.beforeUpgrade(dir, "1.6.0"), null);
});

test("cleanup: old versions and old deletes go, recent ones stay", async (t) => {
    const { storage: s, db } = await storage(t);
    const Devices = require("../../libs/Devices");
    const SyncCleanup = require("../../libs/SyncCleanup");
    const devices = new Devices(db);
    const laptop = devices.register({ id: "laptop-00001", secret: "laptop-secret-123456", name: "Laptop" }).device;

    const now = Date.now();
    for (let i = 1; i <= 4; i++) {
        await s.storeEntry("a.md", { type: "file", action: "created", mtime: i, sha1: "x" }, "v" + i);
    }
    await s.storeEntry("old-delete.md", { type: "file", action: "deleted", mtime: now - 10 * 86400000, sha1: "x" });
    await s.storeEntry("new-delete.md", { type: "file", action: "deleted", mtime: now - 1000, sha1: "x" });
    await s.storeEntry("unseen-delete.md", { type: "file", action: "deleted", mtime: now - 10 * 86400000, sha1: "x" });
    laptop.last_online = now - 5 * 86400000;
    // a device that was offline since before "unseen-delete" holds it back...
    const phone = devices.register({ id: "phone-000001", secret: "phone-secret-1234567", name: "Phone" }).device;
    devices.approve(phone.id);
    phone.last_online = now - 20 * 86400000;

    const cleanup = new SyncCleanup({ cleanup: { versions_per_file: 2, keep_deleted_files_time: 3 * 86400 } }, devices);
    await cleanup.run();
    assert.deepEqual((await s.iterateVersions("a.md")).map(v => v.timestamp), [4, 3]);
    assert.ok(await s.readMetadata("old-delete.md"), "phone has not seen it yet");

    // ...until it has been online since
    phone.last_online = now;
    await cleanup.run();
    assert.equal(await s.readMetadata("old-delete.md"), null);
    assert.equal(await s.readMetadata("unseen-delete.md"), null);
    assert.ok(await s.readMetadata("new-delete.md"), "kept for keep_deleted_files_time");
});

test("binary detection ignores case", () => {
    assert.equal(Helpers.isBinary("Photo.PNG"), true);
    assert.equal(Helpers.isBinary("scan.Pdf"), true);
    assert.equal(Helpers.isBinary("a.png"), true);
    assert.equal(Helpers.isBinary("note.md"), false);
    assert.equal(Helpers.isBinary("README"), false);
});
