const cron = require("node-cron");
const Helpers = require("./helpers");

module.exports = class SyncCleanup {
    constructor(config, devices) {
        this.config = config;
        this.devices = devices;

        const cleanup = Object.assign({
            schedule: "0 * * * *",
            versions_per_file: 1000,
            binary_versions_per_file: 3,
            keep_deleted_files_time: 3 * 24 * 60 * 60
        }, config.cleanup || {});
        this.schedule = cleanup.schedule;
        this.versionsPerFile = cleanup.versions_per_file;
        this.binaryVersionsPerFile = cleanup.binary_versions_per_file;
        // seconds in the config
        this.keepDeletedTime = cleanup.keep_deleted_files_time * 1000;
    }

    // https://crontab.guru/
    start() {
        this.task = cron.schedule(this.schedule, async () => {
            await this.run();
        });
        return this.run();
    }

    stop() {
        if (this.task) {
            this.task.stop();
        }
    }

    async run() {
        let allDevicesLastOnline = this.findMinLastOnline();
        let items = await XStorage.iterate();

        let now = Date.now();
        for(let item of items) {
            try {
                let metadata = await XStorage.readMetadata(item);
                if (!metadata) {
                    continue;
                }
                switch (metadata.action) {
                    case "created":
                        if (metadata.type === "file") {
                            const keep = Helpers.isBinary(item) ? this.binaryVersionsPerFile : this.versionsPerFile;
                            await XStorage.pruneVersions(item, keep);
                        }
                        break;
                    case "deleted":
                        // only once every device had the chance to see the delete
                        if (metadata.mtime + this.keepDeletedTime < now && allDevicesLastOnline > metadata.mtime) {
                            await XStorage.delete(item);
                        }
                        break;
                }
            }
            catch(e) {
                console.log("[Error SyncCleanup]", item, e);
            }
        }
    }

    findMinLastOnline() {
        // 1.6.0: only devices that may sync count
        if (this.devices && this.devices.hasApproved()) {
            return this.devices.minLastOnline();
        }

        let minLastOnline = -1;
        for(let id of XDB.devices.list()) {
            const lastOnline = XDB.devices.get(id, "last_online");
            if(minLastOnline == -1 || minLastOnline > lastOnline) {
                minLastOnline = lastOnline;
            }
        }
        return minLastOnline;
    }
}
