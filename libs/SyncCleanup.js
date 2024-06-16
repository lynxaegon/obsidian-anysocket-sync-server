const cron = require("node-cron");

module.exports = class SyncCleanup {
    constructor(config) {
        this.config = config;

        // convert from seconds to ms
        this.config.cleanup.keep_deleted_files_time *= 1000;

        this.setup();
    }

    // https://crontab.guru/
    setup() {
        cron.schedule(this.config.cleanup.schedule, async () => {
            await this.run();
        });
        this.run();
    }

    async run() {
        let allDevicesLastOnline = this.findMinLastOnline();
        let items = await XStorage.iterate();

        // make sure all devices are synced before deleting
        let now = (new Date()).getTime();
        for(let item of items) {
            try {
                let metadata = await XStorage.readMetadata(item);
                switch (metadata.action) {
                    case "created":
                        let versions = await XStorage.iterateVersions(item);
                        let deleteableVersions = versions.slice(this.config.cleanup.versions_per_file);
                        for (let item of deleteableVersions) {
                            await XStorage.delete(item.path);
                        }
                        break;
                    case "deleted":
                        if (metadata.mtime + this.config.cleanup.keep_deleted_files_time < now && allDevicesLastOnline > metadata.mtime) {
                            await XStorage.delete(item);
                        }
                        break;
                }
            }
            catch(e) {
                console.log("[Error SyncCleanup]", e);
            }
        }
    }

    findMinLastOnline() {
        let minLastOnline = -1;
        let devices = XDB.devices.list();

        let lastOnline;
        for(let id of devices) {
            lastOnline = XDB.devices.get(id, "last_online");
            if(minLastOnline == -1) {
                minLastOnline = lastOnline;
                continue;
            }

            if(minLastOnline > lastOnline) {
                minLastOnline = lastOnline;
            }
        }
        return minLastOnline;
    }
}