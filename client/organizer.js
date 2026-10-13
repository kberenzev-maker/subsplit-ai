/**
 * SubSplit AI — Project Organizer Engine
 * Handles project asset classification, safe file copy/move, and ExtendScript DOM synchronization.
 */

const Organizer = (() => {
    const fs = typeof require !== 'undefined' ? require('fs') : null;
    const path = typeof require !== 'undefined' ? require('path') : null;

    const EXTENSIONS_MAP = {
        footage: new Set(['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.wmv', '.flv', '.webm', '.mts', '.m2ts', '.r3d', '.braw', '.prores', '.mxf']),
        audio: new Set(['.wav', '.mp3', '.aac', '.m4a', '.flac', '.aiff', '.aif', '.ogg', '.wma']),
        graphics: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.psd', '.ai', '.eps', '.svg']),
        subtitles: new Set(['.srt', '.vtt', '.sub', '.sbv'])
    };

    const BINS_MAP = {
        sequences: '00_Sequences',
        footage: '01_Footage',
        audio: '02_Audio',
        graphics: '03_Graphics',
        subtitles: '04_Subtitles'
    };

    const STORAGE_KEY = 'subsplit_protected_folders';

    // Получить список защищенных папок (Copy-Only)
    function getProtectedFolders() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    // Сохранить список защищенных папок
    function saveProtectedFolders(folders) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
        } catch (e) {}
    }

    function addProtectedFolder(folderPath) {
        if (!folderPath) return false;
        const normalized = normalizePath(folderPath);
        const current = getProtectedFolders();
        if (!current.includes(normalized)) {
            current.push(normalized);
            saveProtectedFolders(current);
            return true;
        }
        return false;
    }

    function removeProtectedFolder(folderPath) {
        const normalized = normalizePath(folderPath);
        const current = getProtectedFolders().filter(p => p !== normalized);
        saveProtectedFolders(current);
    }

    function normalizePath(p) {
        if (!p) return '';
        let norm = p.replace(/\\/g, '/').trim();
        while (norm.length > 1 && norm.endsWith('/')) {
            norm = norm.slice(0, -1);
        }
        return norm;
    }

    function isSubpath(childPath, parentPath) {
        if (!childPath || !parentPath) return false;
        const c = normalizePath(childPath).toLowerCase();
        const p = normalizePath(parentPath).toLowerCase();
        return c === p || c.startsWith(p + '/');
    }

    function classifyItem(item) {
        if (item.isSequence) {
            return { category: 'sequences', binName: BINS_MAP.sequences };
        }

        if (!item.mediaPath) {
            // Синтетический слой (adjustment layer, matte, title)
            return { category: 'graphics', binName: BINS_MAP.graphics };
        }

        let ext = '';
        if (path) {
            ext = path.extname(item.mediaPath).toLowerCase();
        } else {
            const m = item.mediaPath.match(/\.[0-9a-z]+$/i);
            ext = m ? m[0].toLowerCase() : '';
        }

        if (EXTENSIONS_MAP.footage.has(ext)) {
            return { category: 'footage', binName: BINS_MAP.footage };
        }
        if (EXTENSIONS_MAP.audio.has(ext)) {
            return { category: 'audio', binName: BINS_MAP.audio };
        }
        if (EXTENSIONS_MAP.graphics.has(ext)) {
            return { category: 'graphics', binName: BINS_MAP.graphics };
        }
        if (EXTENSIONS_MAP.subtitles.has(ext)) {
            return { category: 'subtitles', binName: BINS_MAP.subtitles };
        }

        // По умолчанию в Footage
        return { category: 'footage', binName: BINS_MAP.footage };
    }

    function getUniqueDestinationPath(targetFolder, fileName) {
        if (!fs || !path) {
            return targetFolder ? targetFolder.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + fileName : fileName;
        }

        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        let candidate = path.join(targetFolder, fileName);
        let index = 1;

        while (fs.existsSync(candidate)) {
            const padIndex = String(index).padStart(2, '0');
            candidate = path.join(targetFolder, `${base}_${padIndex}${ext}`);
            index++;
        }

        return candidate;
    }

    function copyFileSafe(src, dst) {
        if (!fs || !path) return false;
        const dstDir = path.dirname(dst);
        if (!fs.existsSync(dstDir)) {
            fs.mkdirSync(dstDir, { recursive: true });
        }
        fs.copyFileSync(src, dst);
        return true;
    }

    function moveFileSafe(src, dst) {
        if (!fs || !path) return false;
        const dstDir = path.dirname(dst);
        if (!fs.existsSync(dstDir)) {
            fs.mkdirSync(dstDir, { recursive: true });
        }

        try {
            // Попытка атомарного перемещения (в пределах одного тома)
            fs.renameSync(src, dst);
            return true;
        } catch (err) {
            // Если ошибка EXDEV (перемещение между разными физическими дисками/томами APFS)
            if (err.code === 'EXDEV' || err.message.includes('cross-device')) {
                fs.copyFileSync(src, dst);
                // Проверяем размер файла перед удалением оригинала
                const srcStat = fs.statSync(src);
                const dstStat = fs.statSync(dst);
                if (srcStat.size === dstStat.size) {
                    fs.unlinkSync(src);
                    return true;
                } else {
                    throw new Error(`Ошибка сверки размера при переносе ${src}`);
                }
            } else {
                throw err;
            }
        }
    }

    return {
        getProtectedFolders,
        saveProtectedFolders,
        addProtectedFolder,
        removeProtectedFolder,
        normalizePath,
        isSubpath,
        classifyItem,
        getUniqueDestinationPath,
        copyFileSafe,
        moveFileSafe,
        BINS_MAP
    };
})();

if (typeof module !== 'undefined') {
    module.exports = Organizer;
}
