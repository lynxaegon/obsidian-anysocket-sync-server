const crypto = require("crypto");
module.exports = {
    getSHA(data) {
        if(!data)
            return null;

        let sha = crypto.createHash('sha256');
        sha.update(data)
        return sha.digest('hex');
    }
}