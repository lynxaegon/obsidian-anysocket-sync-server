// @ts-nocheck
const FSAdapter = require("./FSAdapter");

module.exports = class Storage {
	constructor(root) {
		this.fsVault = new FSAdapter(root);
	}

    async init() {
        await this.fsVault.init();
    }

	async write(path, data, binary) {
        let metadata = await this.readMetadata(path);
        if(!metadata) {
            return null;
        }

        // don't keep version history for binary files
        if(binary) {
            (await this.fsVault.iterateVersions(path)).map(async item => await this.fsVault.delete(item.path));
        }

		return await this.fsVault.write(path + "/" + metadata.mtime, data, binary);
	}

	async read(path, binary = false) {
        let metadata = await this.readMetadata(path);
        if(!metadata || metadata.type == "folder") {
            return null;
        }

		return await this.fsVault.read(path + "/" + metadata.mtime, binary);
	}

    async readExact(path, binary) {
        return await this.fsVault.read(path, binary);
    }

	async delete(path) {
        return await this.fsVault.delete(path);
	}

	async exists(path) {
		return await this.fsVault.exists(path);
	}

	async readMetadata(path) {
        if(await this.fsVault.exists(path)) {
            return JSON.parse(await this.fsVault.read(path + "/metadata"));
        }
        return null;
	}

	async writeMetadata(path, metadata) {
        return await this.fsVault.write(path + "/metadata", JSON.stringify(metadata));
	}

    async iterate() {
        return await this.fsVault.iterate();
    }

    async iterateVersions(path) {
        return await this.fsVault.iterateVersions(path);
    }
}
