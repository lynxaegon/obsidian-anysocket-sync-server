// @ts-nocheck
const fs = require("fs").promises;
const fsConstants = require("fs").constants;

module.exports = class FSAdapter {
    constructor(basePath) {
        this.basePath = basePath;
    }

    async init() {
        await fs.mkdir(this.basePath, {
            recursive: true
        });
    }

    async write(path, data) {
        if (!await this.exists(path)) {
            let folder = path.split("/").slice(0, -1).join("/");
            if (folder) {
                await fs.mkdir(this.basePath + folder, {
                    recursive: true
                }).catch(() => {
                    // ignored
                });
            }
        }

        await fs.writeFile(this.basePath + path, data, "utf-8");
        return data;
    }

    async read(path) {
        try {
            return await fs.readFile(this.basePath + path, "utf-8");
        } catch (e) {
            return null;
        }
    }

    async exists(path) {
        return fs.access(this.basePath + path, fsConstants.F_OK)
            .then(() => true)
            .catch(() => false)
    }

    async rename(oldPath, newPath) {
        await fs.rename(this.basePath + oldPath, this.basePath + newPath);
    }

    async delete(path) {
        return await fs.rm(this.basePath + path, {
            recursive: true,
            force: true
        });
    }

    async iterate(root) {
        root = root || this.basePath;
        const dirents = await fs.readdir(root, {withFileTypes: true});
        const files = await Promise.all(dirents.map(async (dirent) => {
            let _path = root + "/" + dirent.name;
            if (dirent.isDirectory()) {
                return await this.iterate(_path);
            } else if (dirent.name == "metadata") {
                return [root.replace(this.basePath + "/", "")];
            }
            return [];
        }));
        return Array.prototype.concat(...files);
    }

    async iterateVersions(path) {
        let files = await fs.readdir(this.basePath + path, {withFileTypes: true});
        let versions = [];
        for(let item of files) {
            if(item.isDirectory() || item.name == "metadata") {
                continue;
            }
            versions.push({
                path: path + "/" + item.name,
                timestamp: parseInt(item.name)
            });
        }
        return versions.sort((a, b) => {
            return b.timestamp - a.timestamp;
        });
    }
}
