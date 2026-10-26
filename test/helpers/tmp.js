const fs = require("fs");
const os = require("os");
const path = require("path");

// a fresh directory under the OS temp dir, removed when the test ends
function tmpdir(t, name = "sync") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anysocket-sync-" + name + "-"));
    if (t && t.after) {
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    return dir;
}

// Storage + DB as the server sets them up (they are globals there)
async function storage(t, options) {
    const dir = tmpdir(t, "storage");
    const Storage = require("../../libs/fs/Storage");
    const DB = require("../../libs/DB");
    global.XStorage = new Storage(dir + "/files/", options);
    global.XDB = new DB(dir + "/db");
    await XStorage.init();
    return { dir, storage: XStorage, db: XDB };
}

module.exports = { tmpdir, storage };
