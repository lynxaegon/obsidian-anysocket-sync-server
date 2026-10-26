const fs = require("fs");
const path = require("path");

/**
 * Before a server first runs a new version over existing data, the data is copied
 * to data/backups/pre-<version>-<date>/, once per version.
 */
module.exports = {
    beforeUpgrade(dataDir, version) {
        const files = path.join(dataDir, "files");
        const db = path.join(dataDir, "db");
        const marker = path.join(dataDir, "backups", ".done-" + version);

        if (fs.existsSync(marker)) {
            return null;
        }
        const hasData = fs.existsSync(files) && fs.readdirSync(files).length > 0;
        if (!hasData) {
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, String(Date.now()));
            return null;
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const target = path.join(dataDir, "backups", "pre-" + version + "-" + stamp);
        console.log("[SERVER] Backing up data before running " + version + " to:", target);
        fs.mkdirSync(target, { recursive: true });
        fs.cpSync(files, path.join(target, "files"), { recursive: true });
        if (fs.existsSync(db)) {
            fs.cpSync(db, path.join(target, "db"), { recursive: true });
        }
        fs.writeFileSync(marker, target);
        console.log("[SERVER] Backup done");
        return target;
    }
};
