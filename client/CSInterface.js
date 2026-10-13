/**
 * CSInterface - Minimal, robust Adobe CEP Interface for Premiere Pro
 */

function CSInterface() {}

CSInterface.prototype.evalScript = function(script, callback) {
    if (callback === null || callback === undefined) {
        callback = function(result) {};
    }
    if (window.__adobe_cep__) {
        window.__adobe_cep__.evalScript(script, callback);
    } else {
        console.warn("window.__adobe_cep__ is not available (running outside Premiere Pro).");
        callback(JSON.stringify({ error: "Not inside Premiere Pro CEP" }));
    }
};

CSInterface.prototype.getSystemPath = function(pathType) {
    if (window.__adobe_cep__) {
        var destination = "all";
        return window.__adobe_cep__.getSystemPath(pathType, destination);
    }
    return "";
};

CSInterface.prototype.closeExtension = function() {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.closeExtension();
    }
};

var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};
