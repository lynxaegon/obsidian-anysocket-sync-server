const cron = require("node-cron");

const KEEP_VERSION_HISTORY_COUNT_PER_FILE = 100;
const KEEP_DELETED_HISTORY_TIMESTAMP = 24 * 60 * 60 * 1000;

module.exports = class SyncCleanup {
    constructor(config) {
        this.config = config;

        this.setup();
    }

    // https://crontab.guru/
    setup() {
        cron.schedule("0 * * * *", async () => {
            await this.run();
        });
        this.run();
    }

    async run() {
        let allDevicesLastOnline = this.findMinLastOnline();
        let items = await XStorage.iterate();

        // cleanup deleted files/folders older than 7 days,
        // but make sure all devices are synced before deleting
        let now = (new Date()).getTime();
        for(let item of items) {
            let metadata = await XStorage.readMetadata(item);
            switch (metadata.action) {
                case "created":
                    let versions = await XStorage.iterateVersions(item);
                    let deleteableVersions = versions.slice(KEEP_VERSION_HISTORY_COUNT_PER_FILE);
                    for(let item of deleteableVersions) {
                        await XStorage.delete(item.path);
                    }
                    break;
                case "deleted":
                    if (metadata.mtime + KEEP_DELETED_HISTORY_TIMESTAMP < now && allDevicesLastOnline > metadata.mtime) {
                        await XStorage.delete(item);
                    }
                    break;
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