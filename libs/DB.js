const fs = require("fs");

/**
 * data.json, kept readable by 1.5.x servers: `devices` stays as it was (by device name),
 * everything 1.6.0 adds lives in new keys next to it.
 */
module.exports = class DB {
    constructor(root) {
        this.path = root + "/data.json";
        if(!fs.existsSync(root)) {
            fs.mkdirSync(root, {
                recursive: true
            });
        }

        this.data = null;
        if(fs.existsSync(this.path)) {
            try {
                this.data = JSON.parse(fs.readFileSync(this.path, "utf8"));
            } catch (e) {
                // a 1.5.x server could leave it half-written; keep the broken copy for inspection
                const broken = this.path + ".broken-" + Date.now();
                fs.copyFileSync(this.path, broken);
                console.error("[DB] data.json is corrupt, starting fresh. The old file was kept as:", broken);
            }
        }
        if(!this.data || typeof this.data !== "object") {
            this.data = {};
        }
        if(!this.data.devices || typeof this.data.devices !== "object") {
            this.data.devices = {};
        }
        this.save();

        // legacy device list (by name), used by 1.5.x servers
        this.devices = {
            add: (id) => {
                if(!this.data.devices[id]) {
                    this.data.devices[id] = {};
                    this.save();
                }
            },
            set: (id, key, value) => {
                this.data.devices[id][key] = value;
                this.save();
            },
            get: (id, key) => {
                return this.data.devices[id][key];
            },
            has: (id) => {
                return !!this.data.devices[id];
            },
            remove: (id) => {
                delete this.data.devices[id];
                this.save();
            },
            list: () => {
                return Object.keys(this.data.devices);
            }
        }
    }

    // written to a temp file and renamed over data.json, so a crash never corrupts it
    save() {
        const tmp = this.path + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.data), "utf8");
        fs.renameSync(tmp, this.path);
    }
}
