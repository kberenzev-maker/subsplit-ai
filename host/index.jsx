/**
 * ExtendScript host script for SubSplit AI in Adobe Premiere Pro
 */

(function() {
    try {
        if (typeof $ !== "undefined") {
            $.evalFile = function(pathOrFile) {
                try {
                    var f = (pathOrFile instanceof File) ? pathOrFile : null;
                    if (!f) {
                        var cleanPath = String(pathOrFile || "").replace(/^file:\/\//i, "");
                        try { cleanPath = decodeURI(cleanPath); } catch (e0) {}
                        cleanPath = cleanPath.replace(/%20/g, " ");
                        f = new File(cleanPath);
                    }
                    if (f && f.exists) {
                        f.encoding = "UTF-8";
                        if (f.open("r")) {
                            var src = f.read();
                            f.close();
                            return $.global.eval(src);
                        }
                    }
                } catch (eInner) {}
            };
        }
    } catch (ePatch) {}
})();

// Проверка наличия активного проекта и таймлайна
function getActiveSequenceInfo() {
    try {
        if (!app.project) {
            return JSON.stringify({ error: "Нет открытого проекта Premiere Pro." });
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ error: "Нет активного таймлайна (Sequence). Откройте эпизод." });
        }

        var mediaPaths = [];
        var firstClipPath = "";

        // Проверяем аудиотреки
        for (var a = 0; a < seq.audioTracks.numTracks; a++) {
            var aTrack = seq.audioTracks[a];
            for (var c = 0; c < aTrack.clips.numItems; c++) {
                var clip = aTrack.clips[c];
                if (clip && clip.projectItem) {
                    var p = clip.projectItem.getMediaPath();
                    if (p && p.length > 0) {
                        mediaPaths.push(p);
                        if (!firstClipPath) firstClipPath = p;
                    }
                }
            }
        }

        // Если на аудиотреках пусто, проверяем видеотреки (видео со встроенным звуком)
        if (mediaPaths.length === 0) {
            for (var v = 0; v < seq.videoTracks.numTracks; v++) {
                var vTrack = seq.videoTracks[v];
                for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                    var vClip = vTrack.clips[vc];
                    if (vClip && vClip.projectItem) {
                        var vp = vClip.projectItem.getMediaPath();
                        if (vp && vp.length > 0) {
                            mediaPaths.push(vp);
                            if (!firstClipPath) firstClipPath = vp;
                        }
                    }
                }
            }
        }

        var durationSec = 0;
        if (seq.end) {
            durationSec = seq.end.seconds;
        }

        return JSON.stringify({
            sequenceName: seq.name,
            sequenceId: seq.sequenceID,
            duration: durationSec,
            firstMediaPath: firstClipPath,
            allMediaPaths: mediaPaths
        });
    } catch (err) {
        return JSON.stringify({ error: "Ошибка ExtendScript: " + err.toString() });
    }
}

// Определение папки проекта и автоматическое создание подпапки 'srt' рядом с проектом
function getProjectSrtFolder() {
    try {
        if (!app.project) {
            return JSON.stringify({ error: "Нет открытого проекта Premiere Pro." });
        }
        var pPath = app.project.path;
        if (!pPath || pPath.length === 0) {
            return JSON.stringify({ error: "Проект еще не сохранен на диске." });
        }
        var pFile = new File(pPath);
        if (pFile.exists && pFile.parent) {
            var srtFolder = new Folder(pFile.parent.fsName + "/srt");
            if (!srtFolder.exists) {
                srtFolder.create();
            }
            var seqName = "Subtitles";
            if (app.project.activeSequence && app.project.activeSequence.name) {
                seqName = app.project.activeSequence.name;
            }
            return JSON.stringify({
                status: "success",
                projectPath: pPath,
                projectDir: pFile.parent.fsName,
                srtDir: srtFolder.fsName,
                sequenceName: seqName
            });
        }
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
    return JSON.stringify({ error: "Не удалось получить путь к проекту." });
}

// Получение списка всех аудиотреков активной секвенции
function getAudioTracksList() {
    try {
        if (!app.project || !app.project.activeSequence) {
            return JSON.stringify({ error: "Нет активного таймлайна" });
        }
        var seq = app.project.activeSequence;
        var tracks = [];
        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            var t = seq.audioTracks[i];
            tracks.push({
                index: i,
                name: t.name || ("A" + (i + 1)),
                numClips: t.clips.numItems,
                isMuted: t.isMuted()
            });
        }
        return JSON.stringify({
            sequenceName: seq.name,
            tracks: tracks
        });
    } catch (err) {
        return JSON.stringify({ error: err.toString() });
    }
}

// Экспорт аудиодорожки текущей секвенции со всеми склейками
// targetTrack: индекс трека (0 для A1, 1 для A2) или "all" (микс)
function exportActiveSequenceAudio(outputPath, targetTrack) {
    try {
        if (!app.project || !app.project.activeSequence) {
            return JSON.stringify({ error: "Нет активного таймлайна (Sequence). Откройте эпизод." });
        }

        var seq = app.project.activeSequence;

        // Поиск встроенного пресета WAV в Premiere Pro
        var presetPaths = [
            "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Settings/EncoderPresets/WAV_Mono_16bit_16kHz.epr",
            "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Settings/EncoderPresets/Wave48mono16.epr",
            "/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app/Contents/Settings/EncoderPresets/WAV_Mono_16bit_16kHz.epr",
            "/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app/Contents/Settings/EncoderPresets/Wave48mono16.epr"
        ];

        var validPreset = "";
        for (var i = 0; i < presetPaths.length; i++) {
            var f = new File(presetPaths[i]);
            if (f.exists) {
                validPreset = presetPaths[i];
                break;
            }
        }

        if (!validPreset) {
            return JSON.stringify({ error: "Не найден пресет экспорта аудио WAV в Premiere Pro." });
        }

        // Удаляем старый временный файл если был
        var oldFile = new File(outputPath);
        if (oldFile.exists) {
            oldFile.remove();
        }

        // Сохраняем исходное состояние заглушения (Mute) всех дорожек
        var originalMutes = [];
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            originalMutes.push(seq.audioTracks[t].isMuted());
        }

        // Если выбрана конкретная дорожка (изолируем только голос)
        if (targetTrack !== "all" && targetTrack !== undefined && targetTrack !== null) {
            var trackIdx = parseInt(targetTrack, 10);
            if (!isNaN(trackIdx) && trackIdx >= 0 && trackIdx < seq.audioTracks.numTracks) {
                for (var t = 0; t < seq.audioTracks.numTracks; t++) {
                    if (t === trackIdx) {
                        seq.audioTracks[t].setMute(0); // Оставляем только эту дорожку включенной
                    } else {
                        seq.audioTracks[t].setMute(1); // Заглушаем музыку и спецэффекты на остальных
                    }
                }
            }
        }

        var exportError = null;
        try {
            // Экспорт аудио всего эпизода (0 = ENCODE_ENTIRE) от 00:00:00:00
            seq.exportAsMediaDirect(outputPath, validPreset, 0);
        } catch (e) {
            exportError = e;
        } finally {
            // ОБЯЗАТЕЛЬНО возвращаем таймлайн в исходное состояние пользователя
            for (var t = 0; t < seq.audioTracks.numTracks; t++) {
                try {
                    seq.audioTracks[t].setMute(originalMutes[t] ? 1 : 0);
                } catch (muteErr) {}
            }
        }

        if (exportError) {
            throw exportError;
        }

        var outFile = new File(outputPath);
        if (!outFile.exists || outFile.length === 0) {
            return JSON.stringify({ error: "Не удалось отрендерить аудио секвенции. Проверьте, есть ли клипы на выбранной дорожке." });
        }

        // Сохраняем границы склеек клипов таймлайна для точной мультиязычной транскрибации
        var clipCuts = [];
        var trackNum = (targetTrack === "all" || targetTrack === undefined || targetTrack === null) ? 0 : parseInt(targetTrack, 10);
        if (!isNaN(trackNum) && trackNum >= 0 && trackNum < seq.audioTracks.numTracks) {
            var audTrack = seq.audioTracks[trackNum];
            for (var c = 0; c < audTrack.clips.numItems; c++) {
                var cl = audTrack.clips[c];
                clipCuts.push({
                    index: c,
                    name: cl.name,
                    start: cl.start.seconds,
                    end: cl.end.seconds,
                    duration: cl.duration.seconds
                });
            }
        }

        if (clipCuts.length > 0) {
            try {
                var cutsFile = new File(outputPath + ".cuts.json");
                cutsFile.encoding = "UTF-8";
                if (cutsFile.open("w")) {
                    cutsFile.write(JSON.stringify(clipCuts));
                    cutsFile.close();
                }
            } catch (cutsErr) {}
        }

        return JSON.stringify({
            status: "success",
            wavPath: outputPath,
            sequenceName: seq.name,
            trackUsed: targetTrack,
            numClips: clipCuts.length,
            fileSize: outFile.length
        });
    } catch (err) {
        return JSON.stringify({ error: "Сбой экспорта аудио: " + err.toString() });
    }
}

// Нейтрализация конфликтов с расширением Mister Horse Premiere Composer
// В версиях Premiere Pro 2025/2026 метод qe.project.undoStackIndex() был упразднен Adobe.
// Mister Horse слушает событие onProjectChanged и при любом app.project.importFiles()
// вызывает qeProject.undoStackIndex(), что приводило к сбою ReferenceError.
function neutralizeMisterHorseBugs() {
    try {
        if (typeof app.enableQE === "function") {
            app.enableQE();
        }
    } catch (e) {}

    try {
        if (typeof qe !== "undefined" && qe && qe.project) {
            if (typeof qe.project.undoStackIndex !== "function") {
                qe.project.undoStackIndex = function() { return 0; };
            }
        }
    } catch (e) {}

    try {
        $.global.undoStackIndex = function() { return 0; };
        undoStackIndex = function() { return 0; };
    } catch (e) {}

    try {
        if (typeof Object !== "undefined" && Object.prototype) {
            Object.prototype.undoStackIndex = function() { return 0; };
        }
    } catch (e) {}

    try {
        if (typeof $.mhac !== "undefined" && $.mhac) {
            // Патчим кэшированные QE проекты в Mister Horse
            if ($.mhac.undoGroups && $.mhac.undoGroups._qeProjects) {
                for (var key in $.mhac.undoGroups._qeProjects) {
                    if ($.mhac.undoGroups._qeProjects[key]) {
                        $.mhac.undoGroups._qeProjects[key].undoStackIndex = function() { return 0; };
                    }
                }
            }

            // Патчим getQeProject
            if ($.mhac.undoGroups && typeof $.mhac.undoGroups.getQeProject === "function" && !$.mhac.undoGroups._subsplit_patched) {
                var origGetQe = $.mhac.undoGroups.getQeProject;
                $.mhac.undoGroups.getQeProject = function() {
                    var qp = origGetQe.apply(this, arguments);
                    if (qp && typeof qp.undoStackIndex !== "function") {
                        qp.undoStackIndex = function() { return 0; };
                    }
                    return qp;
                };
                $.mhac.undoGroups._subsplit_patched = true;
            }

            // Защищаем undoGroups.onProjectChanged от вылета
            if ($.mhac.undoGroups && typeof $.mhac.undoGroups.onProjectChanged === "function" && !$.mhac.undoGroups._subsplit_onproj_patched) {
                var origUndoGroupsOnProj = $.mhac.undoGroups.onProjectChanged;
                $.mhac.undoGroups.onProjectChanged = function() {
                    try {
                        return origUndoGroupsOnProj.apply(this, arguments);
                    } catch (err) {
                        return false;
                    }
                };
                $.mhac.undoGroups._subsplit_onproj_patched = true;
            }

            // Защищаем params.onProjectChanged от вылета
            if ($.mhac.params && typeof $.mhac.params.onProjectChanged === "function" && !$.mhac.params._subsplit_patched) {
                var origOnProj = $.mhac.params.onProjectChanged;
                $.mhac.params.onProjectChanged = function() {
                    try {
                        return origOnProj.apply(this, arguments);
                    } catch (err) {
                        return false;
                    }
                };
                $.mhac.params._subsplit_patched = true;
            }
        }
    } catch (e) {}
}

// Запускаем сразу при загрузке скрипта
neutralizeMisterHorseBugs();

// Поиск элемента проекта по пути к файлу
function findProjectItemByPath(filePath) {
    try {
        if (!app.project || !app.project.rootItem) return null;
        var f = new File(filePath);
        var searchName = f.name;
        var searchNameNoExt = searchName.replace(/\.[^\.]+$/, "");
        var normTarget = filePath.replace(/\\/g, "/").toLowerCase();

        function searchBin(bin) {
            if (!bin || !bin.children) return null;
            for (var i = 0; i < bin.children.numItems; i++) {
                var item = bin.children[i];
                if (!item) continue;

                // 1. Проверка прямого медиа-пути
                try {
                    if (item.getMediaPath) {
                        var mp = item.getMediaPath();
                        if (mp && mp.replace(/\\/g, "/").toLowerCase() === normTarget) {
                            return item;
                        }
                    }
                } catch (mpErr) {}

                // 2. Проверка по имени с расширением и без
                if (item.name === searchName || item.name === searchNameNoExt || (item.name + ".srt") === searchName || (item.name + ".mov") === searchName) {
                    return item;
                }

                // 3. Рекурсивный поиск в подпапках / бинах
                if (item.children && item.children.numItems > 0) {
                    var found = searchBin(item);
                    if (found) return found;
                }
            }
            return null;
        }
        return searchBin(app.project.rootItem);
    } catch (e) {
        return null;
    }
}

// ==========================================================================
// Apple Smooth Subtitle Animation Engine & Captions Per-Word Accent Engine
// ==========================================================================

var TICKS_PER_SECOND = 254016000000;

var STOPWORDS_ACCENT = {
    "я": 1, "ты": 1, "он": 1, "она": 1, "оно": 1, "мы": 1, "вы": 1, "они": 1,
    "в": 1, "во": 1, "на": 1, "за": 1, "по": 1, "из": 1, "от": 1, "до": 1,
    "у": 1, "к": 1, "ко": 1, "с": 1, "со": 1, "о": 1, "об": 1, "про": 1,
    "для": 1, "без": 1, "над": 1, "под": 1, "при": 1, "через": 1,
    "и": 1, "а": 1, "но": 1, "да": 1, "или": 1, "ли": 1, "бы": 1, "же": 1,
    "не": 1, "ни": 1, "ну": 1, "вот": 1, "как": 1, "что": 1, "это": 1, "то": 1,
    "так": 1, "тут": 1, "там": 1, "где": 1, "кто": 1, "чем": 1, "если": 1,
    "когда": 1, "чтобы": 1, "хотя": 1, "ведь": 1, "уже": 1, "еще": 1, "ещё": 1,
    "мне": 1, "меня": 1, "тебя": 1, "его": 1, "ее": 1, "её": 1, "нас": 1, "вас": 1, "их": 1,
    "мой": 1, "моя": 1, "мои": 1, "твой": 1, "свой": 1, "наш": 1, "ваш": 1,
    "the": 1, "a": 1, "an": 1, "in": 1, "on": 1, "at": 1, "to": 1, "for": 1,
    "of": 1, "with": 1, "by": 1, "from": 1, "and": 1, "or": 1, "but": 1, "so": 1,
    "is": 1, "are": 1, "was": 1, "were": 1, "be": 1, "been": 1, "am": 1,
    "i": 1, "you": 1, "he": 1, "she": 1, "it": 1, "we": 1, "they": 1, "that": 1, "this": 1
};

function findTextComponentProp(clip) {
    if (!clip || !clip.components) return null;
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i];
        if (!comp) continue;
        var mn = comp.matchName || "";
        var dn = comp.displayName || "";
        if (mn === "AE.ADBE Text" || mn.indexOf("Text") !== -1 || dn === "Text" || dn === "Текст") {
            if (comp.properties && comp.properties.numItems > 0) {
                return comp.properties[0];
            }
        }
    }
    return null;
}

function encodeSubSplitClipName(words, accentIndices) {
    if (!words || words.length === 0) return "\u200B";
    var parts = [];
    for (var i = 0; i < words.length; i++) {
        var w = String(words[i]).replace(/[\u200B\u2060]/g, "");
        if (isIndexInArray(accentIndices, i)) {
            parts.push("\u2060" + w);
        } else {
            parts.push(w);
        }
    }
    return "\u200B" + parts.join(" ");
}

function decodeSubSplitClipName(rawName) {
    var s = String(rawName || "");
    var isMarked = (s.indexOf("\u200B") === 0 || s.indexOf("\u2060") !== -1);
    var withoutZwsp = s.replace(/\u200B/g, "").replace(/[\r\n\t]+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!withoutZwsp) {
        return { isMarked: isMarked, words: [], text: "", accentIndices: [] };
    }
    var rawTokens = withoutZwsp.split(/\s+/);
    var words = [];
    var accentIndices = [];
    for (var i = 0; i < rawTokens.length; i++) {
        var tok = rawTokens[i];
        if (tok.indexOf("\u2060") !== -1) {
            accentIndices.push(i);
        }
        words.push(tok.replace(/\u2060/g, ""));
    }
    return {
        isMarked: isMarked,
        words: words,
        text: words.join(" "),
        accentIndices: accentIndices
    };
}

function isSubSplitAnimClip(clip) {
    if (!clip) return false;
    try {
        var rawName = String(clip.name || "");
        if (rawName.indexOf("\u200B") === 0) {
            return true;
        }
        var textProp = findTextComponentProp(clip);
        if (textProp) {
            return true;
        }
        var cName = rawName.toLowerCase();
        if (
            cName.indexOf("_appleanim") !== -1 ||
            cName.indexOf("apple smooth subtitle") !== -1 ||
            cName.indexOf("applesubtitle") !== -1 ||
            cName.indexOf("[sub]") !== -1
        ) {
            return true;
        }
        if (clip.projectItem && clip.projectItem.name) {
            var pName = String(clip.projectItem.name).toLowerCase();
            if (
                pName.indexOf("apple smooth subtitle") !== -1 ||
                pName.indexOf("applesubtitle") !== -1 ||
                pName.indexOf("_appleanim") !== -1
            ) {
                return true;
            }
        }
    } catch (e) {}
    return false;
}

function findSubtitleMogrtFile(isVertical) {
    var fileName = isVertical ? "AppleSubtitle_9x16.mogrt" : "AppleSubtitle_16x9.mogrt";
    var candidates = [];

    try {
        if (typeof $ !== "undefined" && $.fileName) {
            var hostFile = new File($.fileName);
            if (hostFile && hostFile.parent && hostFile.parent.parent) {
                candidates.push(hostFile.parent.parent.fsName + "/assets/mogrts/" + fileName);
            }
        }
    } catch (e1) {}

    try {
        if (Folder.userData) {
            candidates.push(Folder.userData.fsName + "/Adobe/CEP/extensions/com.antigravity.subsplit/assets/mogrts/" + fileName);
        }
        if (Folder.commonFiles) {
            candidates.push(Folder.commonFiles.fsName + "/Adobe/CEP/extensions/com.antigravity.subsplit/assets/mogrts/" + fileName);
        }
        if (Folder.myDocuments) {
            candidates.push(Folder.myDocuments.fsName + "/antigravity/lively-hertz/assets/mogrts/" + fileName);
        }
    } catch (e2) {}

    for (var i = 0; i < candidates.length; i++) {
        var f = new File(candidates[i]);
        if (f.exists) {
            return f;
        }
    }
    return null;
}

function parseSrtTimeToSeconds(tc) {
    if (!tc) return 0;
    var s = String(tc).replace(/^\s+|\s+$/g, "").replace(",", ".");
    var parts = s.split(":");
    if (parts.length < 3) return 0;
    var hh = parseFloat(parts[0]) || 0;
    var mm = parseFloat(parts[1]) || 0;
    var ss = parseFloat(parts[2]) || 0;
    return hh * 3600.0 + mm * 60.0 + ss;
}

function parseSrtFileInExtendScript(srtPath) {
    var f = new File(srtPath);
    if (!f.exists) return [];

    f.encoding = "UTF-8";
    if (!f.open("r")) return [];
    var raw = f.read();
    f.close();

    if (!raw) return [];
    if (raw.charCodeAt(0) === 0xFEFF) {
        raw = raw.slice(1);
    }

    var normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var blocks = normalized.split(/\n\s*\n/);
    var cues = [];

    for (var i = 0; i < blocks.length; i++) {
        var lines = blocks[i].replace(/^\s+|\s+$/g, "").split("\n");
        if (lines.length < 2) continue;

        var timeLineIdx = -1;
        for (var l = 0; l < lines.length; l++) {
            if (lines[l].indexOf("-->") !== -1) {
                timeLineIdx = l;
                break;
            }
        }
        if (timeLineIdx === -1) continue;

        var arrowParts = lines[timeLineIdx].split("-->");
        if (arrowParts.length < 2) continue;

        var startSec = parseSrtTimeToSeconds(arrowParts[0]);
        var endSec = parseSrtTimeToSeconds(arrowParts[1]);
        if (endSec <= startSec) {
            endSec = startSec + 0.35;
        }

        var textLines = [];
        for (var tl = timeLineIdx + 1; tl < lines.length; tl++) {
            var cleaned = lines[tl].replace(/<[^>]+>/g, "").replace(/^\s+|\s+$/g, "");
            if (cleaned.length > 0) {
                textLines.push(cleaned);
            }
        }

        if (textLines.length > 0) {
            cues.push({
                start: startSec,
                end: endSec,
                text: textLines.join(" ")
            });
        }
    }
    return cues;
}

function splitPhraseIntoWords(textStr) {
    if (!textStr) return [];
    var norm = String(textStr).replace(/[\r\n\t]+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!norm) return [];
    return norm.split(/\s+/);
}

function cleanWordForScore(w) {
    if (!w) return "";
    return String(w).toLowerCase().replace(/[^a-zA-Zа-яА-ЯёЁ0-9]/g, "");
}

function pickSmartAccentWordIndex(words) {
    if (!words || words.length < 2) return -1;
    var bestIdx = -1;
    var bestScore = -1;

    for (var i = 0; i < words.length; i++) {
        var cw = cleanWordForScore(words[i]);
        if (!cw || cw.length < 3) continue;
        if (STOPWORDS_ACCENT[cw]) continue;

        // Предпочитаем самое содержательное слово (с небольшим бонусом последнему ударному слову фразы)
        var score = cw.length * 10 + (i === words.length - 1 ? 8 : 0);
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }
    return bestIdx;
}

function parseHexToColorInt(hexStr, fallbackInt) {
    if (!hexStr) return fallbackInt;
    var clean = String(hexStr).replace(/[^0-9a-fA-F]/g, "");
    if (clean.length !== 6) return fallbackInt;
    var num = parseInt(clean, 16);
    if (isNaN(num)) return fallbackInt;
    return num;
}

function isIndexInArray(arr, idx) {
    if (!arr || !arr.length) return false;
    for (var i = 0; i < arr.length; i++) {
        if (Number(arr[i]) === idx) return true;
    }
    return false;
}

function compressStyleRuns(runs) {
    if (!runs || runs.length === 0) return [[0, 0]];
    var out = [runs[0]];
    for (var i = 1; i < runs.length; i++) {
        if (runs[i][1] !== out[out.length - 1][1]) {
            out.push(runs[i]);
        }
    }
    return out;
}

function wrapSubtitleTextForFrame(textStr, isVertical, isSecondaryTrack, maxLines) {
    if (!textStr) return "";
    var limit = (typeof maxLines === "number" && maxLines >= 1) ? maxLines : 2;
    var singleLine = String(textStr).replace(/[\r\n\t]+/g, " ").replace(/^\s+|\s+$/g, "");
    if (limit <= 1) {
        return singleLine;
    }

    var maxLineChars = isVertical ? (isSecondaryTrack ? 36 : 24) : (isSecondaryTrack ? 50 : 38);
    if (singleLine.length <= maxLineChars || singleLine.indexOf(" ") === -1) {
        return singleLine;
    }

    var words = singleLine.split(/\s+/);
    if (words.length <= 1) return singleLine;

    if (limit === 2 || words.length <= 3) {
        var bestIdx = 1;
        var bestDiff = 999999;
        for (var i = 1; i < words.length; i++) {
            var l1 = words.slice(0, i).join(" ");
            var l2 = words.slice(i).join(" ");
            var diff = Math.abs(l1.length - l2.length);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }
        return words.slice(0, bestIdx).join(" ") + "\r" + words.slice(bestIdx).join(" ");
    } else {
        // limit >= 3: делим на 3 сбалансированные строки
        var bestI = 1, bestJ = 2;
        var bestDiff = 999999;
        for (var i = 1; i < words.length - 1; i++) {
            for (var j = i + 1; j < words.length; j++) {
                var l1 = words.slice(0, i).join(" ");
                var l2 = words.slice(i, j).join(" ");
                var l3 = words.slice(j).join(" ");
                var maxLen = Math.max(l1.length, l2.length, l3.length);
                var minLen = Math.min(l1.length, l2.length, l3.length);
                var diff = maxLen - minLen;
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestI = i;
                    bestJ = j;
                }
            }
        }
        return words.slice(0, bestI).join(" ") + "\r" + words.slice(bestI, bestJ).join(" ") + "\r" + words.slice(bestJ).join(" ");
    }
}

function buildAppleTextDocPayload(textStr, isSecondaryTrack, seqW, seqH, accentIndices, accentCfg) {
    var isVertical = (seqH > seqW);
    var cfg = accentCfg || {};
    var maxLines = (typeof cfg.maxLines === "number" && cfg.maxLines >= 1) ? cfg.maxLines : 2;
    var baseFontSize = isSecondaryTrack ? (isVertical ? 40 : 38) : (isVertical ? 56 : 52);
    var words = splitPhraseIntoWords(textStr);
    if (maxLines === 1 && words.length >= 4 && isVertical) {
        baseFontSize = Math.max(38, Math.round(56 * (3.8 / words.length)));
    }
    var normalColorInt = isSecondaryTrack ? 14540253 : 16777215; // #DDDDDD vs #FFFFFF
    var fontName = isSecondaryTrack ? "HelveticaNeue-Medium" : "HelveticaNeue-Bold";

    var scaleRatio = Number(cfg.scaleRatio) || 1.72;
    var accentColorInt = parseHexToColorInt(cfg.colorHex || "#FFD60A", 16766474);
    var accentCaps = (typeof cfg.upperCase === "boolean") ? cfg.upperCase : true;
    var stackLine = (maxLines > 1 && typeof cfg.stackLine === "boolean") ? cfg.stackLine : (maxLines > 1);

    var hasAccents = (!isSecondaryTrack && accentIndices && accentIndices.length > 0 && words.length > 0);

    var finalText = "";
    var fontSizeRuns = [];
    var fillColorRuns = [];

    if (hasAccents) {
        var normalSizeWhenAccented = isVertical ? 48 : 45;
        if (maxLines === 1 && words.length >= 4 && isVertical) {
            normalSizeWhenAccented = Math.max(34, Math.round(48 * (3.8 / words.length)));
        }
        var accentFontSize = Math.round(baseFontSize * scaleRatio);
        var hasBothTypes = (accentIndices.length < words.length);

        var curPos = 0;
        var lineCount = 1;
        for (var wIdx = 0; wIdx < words.length; wIdx++) {
            var isAcc = isIndexInArray(accentIndices, wIdx);
            var prevIsAcc = (wIdx > 0) ? isIndexInArray(accentIndices, wIdx - 1) : isAcc;

            if (wIdx > 0) {
                var shouldBreak = (stackLine && hasBothTypes && (isAcc !== prevIsAcc) && (lineCount < maxLines));
                var sep = shouldBreak ? "\r" : " ";
                if (shouldBreak) lineCount++;
                finalText += sep;
                curPos += sep.length;
            }

            var wordToken = String(words[wIdx]);
            if (isAcc && accentCaps) {
                wordToken = wordToken.toUpperCase();
            }

            var wSize = isAcc ? accentFontSize : (hasBothTypes ? normalSizeWhenAccented : accentFontSize);
            var wColor = isAcc ? accentColorInt : normalColorInt;

            fontSizeRuns.push([curPos, wSize]);
            fillColorRuns.push([curPos, wColor]);

            finalText += wordToken;
            curPos += wordToken.length;
        }

        fontSizeRuns = compressStyleRuns(fontSizeRuns);
        fillColorRuns = compressStyleRuns(fillColorRuns);
    } else {
        finalText = wrapSubtitleTextForFrame(textStr, isVertical, isSecondaryTrack, maxLines);
        fontSizeRuns = [[0, baseFontSize]];
        fillColorRuns = [[0, normalColorInt]];
    }

    var doc = {
        "mTextParam": {
            "mAlignment": 2,
            "mDefaultRun": [],
            "mHeight": 0,
            "mHindiDigits": false,
            "mIndic": false,
            "mIsVerticalText": false,
            "mLeading": 0,
            "mLigatures": false,
            "mRTL": false,
            "mShadowAngle": 135,
            "mShadowBlur": 24,
            "mShadowColor": 0,
            "mShadowOffset": 6,
            "mShadowOpacity": 78,
            "mShadowSize": 2,
            "mShadowVisible": true,
            "mStyleSheet": {
                "mBaselineOption": { "mParamValues": [[0, 0]] },
                "mBaselineShift": { "mParamValues": [[0, 0]] },
                "mCapsOption": { "mParamValues": [[0, 0]] },
                "mFauxBold": { "mParamValues": [[0, false]] },
                "mFauxItalic": { "mParamValues": [[0, false]] },
                "mFillColor": { "mParamValues": fillColorRuns },
                "mFillOverStroke": { "mParamValues": [[0, true]] },
                "mFillVisible": { "mParamValues": [[0, true]] },
                "mFontName": { "mParamValues": [[0, fontName]] },
                "mFontSize": { "mParamValues": fontSizeRuns },
                "mKerning": { "mParamValues": [[0, 0]] },
                "mStrokeColor": { "mParamValues": [[0, 0]] },
                "mStrokeVisible": { "mParamValues": [[0, false]] },
                "mStrokeWidth": { "mParamValues": [[0, 1]] },
                "mText": String(finalText || ""),
                "mTracking": { "mParamValues": [[0, 0]] },
                "mTsumi": { "mParamValues": [[0, 0]] }
            },
            "mTabWidth": 400,
            "mWidth": 0
        },
        "mVersion": 1
    };

    return "0000" + JSON.stringify(doc);
}

function selectTargetVideoTrackForAnim(seq, isSecondaryTrack, avoidTrackIdx) {
    var numTracks = (seq && seq.videoTracks) ? seq.videoTracks.numTracks : 0;
    if (numTracks <= 1) return -1;

    var minTrack = isSecondaryTrack ? 2 : 1;
    if (minTrack >= numTracks) {
        return -1;
    }

    // 1. Для основной дорожки сначала очищаем все старые клипы SubSplit на дорожках V2+,
    // чтобы повторная генерация никогда не оставляла старые дубликаты
    if (!isSecondaryTrack) {
        var reusedTrack = -1;
        for (var t = 1; t < numTracks; t++) {
            var tr = seq.videoTracks[t];
            if (!tr || !tr.clips || tr.clips.numItems === 0) continue;

            var subClipIndices = [];
            for (var c = 0; c < tr.clips.numItems; c++) {
                var cl = tr.clips[c];
                if (cl && isSubSplitAnimClip(cl)) {
                    subClipIndices.push(c);
                }
            }

            if (subClipIndices.length > 0) {
                var wasAllSub = (subClipIndices.length === tr.clips.numItems);
                for (var r = subClipIndices.length - 1; r >= 0; r--) {
                    try {
                        tr.clips[subClipIndices[r]].remove(false, false);
                    } catch (remE) {}
                }
                if (wasAllSub && reusedTrack === -1) {
                    reusedTrack = t;
                }
            }
        }
        if (reusedTrack !== -1) {
            return reusedTrack;
        }
    }

    // 2. Ищем первую свободную верхнюю дорожку
    for (var t2 = minTrack; t2 < numTracks; t2++) {
        if (typeof avoidTrackIdx === "number" && t2 === avoidTrackIdx) continue;
        var tr2 = seq.videoTracks[t2];
        if (tr2 && (!tr2.clips || tr2.clips.numItems === 0)) {
            return t2;
        }
    }

    // 3. Fallback на самую верхнюю дорожку
    var fallbackIdx = numTracks - 1;
    if (typeof avoidTrackIdx === "number" && fallbackIdx === avoidTrackIdx) {
        return -1;
    }
    return fallbackIdx;
}

// ==========================================================================
// Mathematical Apple Smooth Easing & Damped Spring Samplers
// ==========================================================================

function evalAppleCurve(curveType, p) {
    if (p <= 0) return 0.0;
    if (p >= 1) return 1.0;

    if (curveType === "quint_out") {
        // iOS Fluid cubic-bezier(0.16, 1, 0.3, 1): быстрый старт + очень длинный плавный довод
        return 1.0 - Math.pow(1.0 - p, 4.2);
    }
    if (curveType === "spring_damped") {
        // Критически демпфированная пружина iOS 18 с мягким перелётом +3.2% и плавной посадкой
        var raw = 1.0 - Math.exp(-5.5 * p) * Math.cos(3.75 * p);
        var endRaw = 1.0 - Math.exp(-5.5) * Math.cos(3.75);
        return raw / endRaw;
    }
    if (curveType === "spring_pulse") {
        // Упругий импульс для акцентных фраз (+5.4% мягкий перелёт без резких рывков)
        var rawP = 1.0 - Math.exp(-4.9 * p) * Math.cos(4.15 * p);
        var endP = 1.0 - Math.exp(-4.9) * Math.cos(4.15);
        return rawP / endP;
    }
    if (curveType === "ease_in_soft") {
        // Мягкое затухание в конце фразы
        return Math.pow(p, 2.6);
    }
    // Smooth cosine S-curve fallback
    return 0.5 - 0.5 * Math.cos(Math.PI * p);
}

var APPLE_CURVE_STEPS = [0.0, 0.14, 0.28, 0.45, 0.64, 0.82, 1.0];

function addSmoothKey(prop, timeSec, val, updateUI) {
    if (!prop) return;
    try {
        prop.addKey(timeSec);
        prop.setValueAtKey(timeSec, val, !!updateUI);
        if (typeof prop.setInterpolationTypeAtKey === "function") {
            prop.setInterpolationTypeAtKey(timeSec, 5, false);
        }
    } catch (e) {}
}

function addSampledCurve1D(prop, tStart, duration, valStart, valEnd, curveType, updateOnLast) {
    if (!prop || duration <= 0.01) return;
    var n = APPLE_CURVE_STEPS.length;
    for (var i = 0; i < n; i++) {
        var p = APPLE_CURVE_STEPS[i];
        var t = tStart + duration * p;
        var k = evalAppleCurve(curveType, p);
        var v = valStart + (valEnd - valStart) * k;
        var isLast = (i === n - 1) && !!updateOnLast;
        addSmoothKey(prop, t, v, isLast);
    }
}

function addSampledCurve2D(prop, tStart, duration, posStart, posEnd, curveType, updateOnLast) {
    if (!prop || duration <= 0.01) return;
    var n = APPLE_CURVE_STEPS.length;
    for (var i = 0; i < n; i++) {
        var p = APPLE_CURVE_STEPS[i];
        var t = tStart + duration * p;
        var k = evalAppleCurve(curveType, p);
        var vx = posStart[0] + (posEnd[0] - posStart[0]) * k;
        var vy = posStart[1] + (posEnd[1] - posStart[1]) * k;
        var isLast = (i === n - 1) && !!updateOnLast;
        addSmoothKey(prop, t, [vx, vy], isLast);
    }
}

function clearExistingKeys(prop) {
    if (!prop) return;
    try {
        if (typeof prop.isTimeVarying === "function" && prop.isTimeVarying()) {
            prop.setTimeVarying(false);
        }
    } catch (e) {}
}

function applyAppleSmoothKeyframes(clip, animStyle, cueDur, isSecondaryTrack, seqW, seqH, hasImmediateNext) {
    if (!clip || !clip.components) return;

    var isVertical = (seqH > seqW);
    var baseY = isVertical
        ? (isSecondaryTrack ? 0.855 : 0.785)
        : (isSecondaryTrack ? 0.895 : 0.825);
    var refW = isVertical ? 1080.0 : 1920.0;
    var baseScale = (Math.abs(seqW - refW) > 10) ? ((seqW / refW) * 100.0) : 100.0;

    var motionComp = null;
    var opacityComp = null;

    for (var m = 0; m < clip.components.numItems; m++) {
        var comp = clip.components[m];
        if (!comp) continue;
        var mn = comp.matchName || "";
        var dn = comp.displayName || "";
        if (mn === "AE.ADBE Motion" || dn === "Motion" || dn === "Движение") {
            motionComp = comp;
        } else if (mn === "AE.ADBE Opacity" || dn === "Opacity" || dn === "Непрозрачность") {
            opacityComp = comp;
        }
    }

    var posProp = (motionComp && motionComp.properties && motionComp.properties.numItems > 0) ? motionComp.properties[0] : null;
    var scaleProp = (motionComp && motionComp.properties && motionComp.properties.numItems > 1) ? motionComp.properties[1] : null;
    var rotProp = (motionComp && motionComp.properties && motionComp.properties.numItems > 4) ? motionComp.properties[4] : null;
    var opProp = (opacityComp && opacityComp.properties && opacityComp.properties.numItems > 0) ? opacityComp.properties[0] : null;

    clearExistingKeys(posProp);
    clearExistingKeys(scaleProp);
    clearExistingKeys(rotProp);
    clearExistingKeys(opProp);

    var clipIn = 0.0;
    try {
        if (clip.inPoint && typeof clip.inPoint.seconds === "number") {
            clipIn = clip.inPoint.seconds;
        }
    } catch (eIn) {}

    var dur = Math.max(0.24, Number(cueDur) || 1.0);
    // Увеличенное время входа (до 0.28с) даёт плавную кривую замедления Apple iOS 18
    var inDur = Math.min(0.28, Math.max(0.16, dur * 0.42));
    var fadeInDur = Math.min(0.18, inDur * 0.72);
    // Если следующая фраза идёт вплотную (hasImmediateNext), не мигаем длинным уходом в темноту
    var outDur = hasImmediateNext ? Math.min(0.055, dur * 0.12) : Math.min(0.18, dur * 0.28);
    var tOutStart = Math.max(clipIn + inDur + 0.02, clipIn + dur - outDur);

    try {
        if (animStyle === "spring_pop") {
            // Apple Spring Pop: многоточечная демпфированная пружина CASpringAnimation
            if (posProp) {
                posProp.setTimeVarying(true);
                addSampledCurve2D(posProp, clipIn, inDur, [0.5, baseY + 0.018], [0.5, baseY], "quint_out", false);
                if (!hasImmediateNext && dur > 0.45) {
                    addSmoothKey(posProp, tOutStart, [0.5, baseY], false);
                    addSmoothKey(posProp, clipIn + dur, [0.5, baseY - 0.008], false);
                }
            }
            if (scaleProp) {
                scaleProp.setTimeVarying(true);
                addSampledCurve1D(scaleProp, clipIn, inDur, baseScale * 0.84, baseScale * 1.00, "spring_damped", false);
                if (!hasImmediateNext && dur > 0.45) {
                    addSmoothKey(scaleProp, tOutStart, baseScale * 1.00, false);
                    addSampledCurve1D(scaleProp, tOutStart, outDur, baseScale * 1.00, baseScale * 0.94, "ease_in_soft", false);
                }
            }
            if (opProp) {
                opProp.setTimeVarying(true);
                addSampledCurve1D(opProp, clipIn, fadeInDur, 0.0, 100.0, "quint_out", hasImmediateNext);
                if (!hasImmediateNext) {
                    addSmoothKey(opProp, tOutStart, 100.0, false);
                    addSampledCurve1D(opProp, tOutStart, outDur, 100.0, 0.0, "ease_in_soft", true);
                }
            }
        } else if (animStyle === "blur_reveal") {
            // Apple Music Live Lyrics: невесомое всплытие с длинным плавным хвостом торможения
            if (posProp) {
                posProp.setTimeVarying(true);
                addSampledCurve2D(posProp, clipIn, inDur, [0.5, baseY + 0.028], [0.5, baseY], "quint_out", false);
                if (!hasImmediateNext && dur > 0.45) {
                    addSmoothKey(posProp, tOutStart, [0.5, baseY], false);
                    addSampledCurve2D(posProp, tOutStart, outDur, [0.5, baseY], [0.5, baseY - 0.012], "ease_in_soft", false);
                }
            }
            if (scaleProp) {
                scaleProp.setTimeVarying(true);
                addSampledCurve1D(scaleProp, clipIn, inDur, baseScale * 0.92, baseScale * 1.00, "quint_out", false);
                if (!hasImmediateNext && dur > 0.45) {
                    addSmoothKey(scaleProp, tOutStart, baseScale * 1.00, false);
                    addSampledCurve1D(scaleProp, tOutStart, outDur, baseScale * 1.00, baseScale * 0.96, "ease_in_soft", false);
                }
            }
            if (opProp) {
                opProp.setTimeVarying(true);
                addSampledCurve1D(opProp, clipIn, inDur * 0.85, 0.0, 100.0, "quint_out", hasImmediateNext);
                if (!hasImmediateNext) {
                    addSmoothKey(opProp, tOutStart, 100.0, false);
                    addSampledCurve1D(opProp, tOutStart, outDur, 100.0, 0.0, "ease_in_soft", true);
                }
            }
        } else if (animStyle === "fluid_slide") {
            // Fluid Slide Up: инерционный выезд снизу по кривой cubic-bezier(0.16, 1, 0.3, 1)
            if (posProp) {
                posProp.setTimeVarying(true);
                addSampledCurve2D(posProp, clipIn, inDur, [0.5, baseY + 0.038], [0.5, baseY], "quint_out", false);
                if (!hasImmediateNext && dur > 0.45) {
                    addSmoothKey(posProp, tOutStart, [0.5, baseY], false);
                    addSampledCurve2D(posProp, tOutStart, outDur, [0.5, baseY], [0.5, baseY - 0.016], "ease_in_soft", false);
                }
            }
            if (scaleProp) {
                scaleProp.setTimeVarying(false);
                scaleProp.setValue(baseScale, false);
            }
            if (opProp) {
                opProp.setTimeVarying(true);
                addSampledCurve1D(opProp, clipIn, fadeInDur, 0.0, 100.0, "quint_out", hasImmediateNext);
                if (!hasImmediateNext) {
                    addSmoothKey(opProp, tOutStart, 100.0, false);
                    addSampledCurve1D(opProp, tOutStart, outDur, 100.0, 0.0, "ease_in_soft", true);
                }
            }
        } else if (animStyle === "dynamic_bounce") {
            // Dynamic Pulse: упругий акцентный панч с мягким микро-доворотом
            if (posProp) {
                posProp.setTimeVarying(true);
                addSampledCurve2D(posProp, clipIn, inDur, [0.5, baseY + 0.022], [0.5, baseY], "spring_damped", false);
            }
            if (scaleProp) {
                scaleProp.setTimeVarying(true);
                addSampledCurve1D(scaleProp, clipIn, inDur, baseScale * 0.76, baseScale * 1.00, "spring_pulse", false);
                if (!hasImmediateNext && dur > 0.45) {
                    addSmoothKey(scaleProp, tOutStart, baseScale * 1.00, false);
                    addSampledCurve1D(scaleProp, tOutStart, outDur, baseScale * 1.00, baseScale * 0.92, "ease_in_soft", false);
                }
            }
            if (rotProp) {
                rotProp.setTimeVarying(true);
                addSampledCurve1D(rotProp, clipIn, inDur, -1.5, 0.0, "spring_damped", false);
            }
            if (opProp) {
                opProp.setTimeVarying(true);
                addSampledCurve1D(opProp, clipIn, fadeInDur, 0.0, 100.0, "quint_out", hasImmediateNext);
                if (!hasImmediateNext) {
                    addSmoothKey(opProp, tOutStart, 100.0, false);
                    addSampledCurve1D(opProp, tOutStart, outDur, 100.0, 0.0, "ease_in_soft", true);
                }
            }
        } else {
            if (posProp) {
                posProp.setTimeVarying(false);
                posProp.setValue([0.5, baseY], false);
            }
            if (scaleProp) {
                scaleProp.setTimeVarying(false);
                scaleProp.setValue(baseScale, true);
            }
        }
    } catch (kfErr) {}
}

function placeAnimatedGraphicSubtitles(seq, srtPath, animStyle, isSecondaryTrack, avoidTrackIdx, accentCfg) {
    if (!seq || !srtPath) {
        return { placed: false, reason: "Не передан таймлайн или путь к SRT" };
    }

    var cues = parseSrtFileInExtendScript(srtPath);
    if (!cues || cues.length === 0) {
        return { placed: false, reason: "В SRT файле не найдено фраз для размещения" };
    }

    // Бесшовная склейка микро-пауз (< 0.14 сек) между соседними фразами, чтобы не было мигания
    for (var b = 0; b < cues.length - 1; b++) {
        var gap = cues[b + 1].start - cues[b].end;
        if (gap >= 0 && gap <= 0.14) {
            cues[b].end = cues[b + 1].start;
            cues[b].hasImmediateNext = true;
        } else {
            cues[b].hasImmediateNext = false;
        }
    }
    cues[cues.length - 1].hasImmediateNext = false;

    var seqW = Number(seq.frameSizeHorizontal) || 1080;
    var seqH = Number(seq.frameSizeVertical) || 1920;
    var isVertical = (seqH > seqW);

    var mogrtFile = findSubtitleMogrtFile(isVertical);
    if (!mogrtFile || !mogrtFile.exists) {
        return { placed: false, reason: "Не найден шаблон MOGRT для субтитров" };
    }

    var targetTrackIdx = selectTargetVideoTrackForAnim(seq, !!isSecondaryTrack, avoidTrackIdx);
    if (targetTrackIdx < 0 || !seq.videoTracks[targetTrackIdx]) {
        return { placed: false, reason: "Нет свободной видеодорожки для второй линии Graphic" };
    }

    var targetTrack = seq.videoTracks[targetTrackIdx];
    var placedCount = 0;
    var cfg = accentCfg || {};
    var autoAccent = (!isSecondaryTrack && (typeof cfg.autoAccent === "boolean" ? cfg.autoAccent : (typeof cfg.enabled === "boolean" ? cfg.enabled : true)));
    var singleWordCooldown = 0;

    for (var i = 0; i < cues.length; i++) {
        var cue = cues[i];
        var startTicksNum = Math.round(cue.start * TICKS_PER_SECOND);
        var startTicksStr = String(startTicksNum);
        var cueDur = Math.max(0.20, cue.end - cue.start);

        var importedClip = null;
        try {
            importedClip = seq.importMGT(mogrtFile.fsName, startTicksStr, targetTrackIdx, 0);
        } catch (mgtErr) {
            importedClip = null;
        }

        if (!importedClip && targetTrack.clips && targetTrack.clips.numItems > 0) {
            for (var ci = targetTrack.clips.numItems - 1; ci >= 0; ci--) {
                var cand = targetTrack.clips[ci];
                if (cand && cand.start && Math.abs(Number(cand.start.ticks) - startTicksNum) < (TICKS_PER_SECOND * 0.25)) {
                    importedClip = cand;
                    break;
                }
            }
        }

        if (!importedClip) continue;

        // Подрезаем или растягиваем длительность Graphic-клипа точно под тайминг фразы
        try {
            if (cueDur > 4.8) {
                var baseInSec = (importedClip.inPoint && typeof importedClip.inPoint.seconds === "number")
                    ? importedClip.inPoint.seconds
                    : 0.0;
                var outT = new Time();
                outT.seconds = baseInSec + cueDur;
                importedClip.outPoint = outT;
            }
            var endT = new Time();
            endT.seconds = cue.end;
            importedClip.end = endT;
        } catch (trimErr) {}

        var cleanLabel = cue.text.replace(/[\r\n\u200B\u2060]+/g, " ");
        var words = splitPhraseIntoWords(cleanLabel);
        var accentIndices = [];
        if (autoAccent) {
            if (words.length >= 2) {
                var autoIdx = pickSmartAccentWordIndex(words);
                if (autoIdx >= 0) {
                    accentIndices.push(autoIdx);
                }
            } else if (words.length === 1) {
                var cw1 = cleanWordForScore(words[0]);
                if (singleWordCooldown <= 0 && cw1.length >= 6 && !STOPWORDS_ACCENT[cw1]) {
                    accentIndices.push(0);
                    singleWordCooldown = 2;
                } else {
                    singleWordCooldown--;
                }
            }
        }

        try {
            importedClip.name = encodeSubSplitClipName(words, accentIndices);
        } catch (nameErr) {}

        // Записываем редактируемый текст в компонент Text (AE.ADBE Text -> Source Text)
        try {
            var textProp = findTextComponentProp(importedClip);
            if (textProp) {
                try {
                    if (typeof textProp.isTimeVarying === "function" && textProp.isTimeVarying()) {
                        textProp.setTimeVarying(false);
                    }
                } catch (tvErr) {}
                var payload = buildAppleTextDocPayload(words.join(" "), !!isSecondaryTrack, seqW, seqH, accentIndices, cfg);
                textProp.setValue(payload, false);
            }
        } catch (txtErr) {}

        // Применяем многоточечные плавные кривые Apple Smooth на Motion + Opacity
        applyAppleSmoothKeyframes(
            importedClip,
            animStyle,
            cueDur,
            !!isSecondaryTrack,
            seqW,
            seqH,
            !!cue.hasImmediateNext
        );
        placedCount++;
    }

    return {
        placed: placedCount > 0,
        placedCount: placedCount,
        trackIndex: targetTrackIdx
    };
}

// ==========================================================================
// Interactive Captions Word Accent Editor API (Live Timeline Sync)
// ==========================================================================

function detectAccentedWordIndicesFromDoc(words, docStr) {
    var accented = [];
    if (!words || words.length === 0 || !docStr || docStr.indexOf('0000{"mTextParam"') !== 0) {
        return accented;
    }
    try {
        var doc = JSON.parse(docStr.slice(4));
        var ss = doc && doc.mTextParam && doc.mTextParam.mStyleSheet;
        if (!ss || !ss.mFontSize || !ss.mFontSize.mParamValues) return accented;
        var runs = ss.mFontSize.mParamValues;
        var colorRuns = (ss.mFillColor && ss.mFillColor.mParamValues) ? ss.mFillColor.mParamValues : [[0, 16777215]];
        if (!runs || runs.length === 0) return accented;

        var minSize = 9999;
        var maxSize = 0;
        for (var r = 0; r < runs.length; r++) {
            var sz = Number(runs[r][1]) || 0;
            if (sz < minSize) minSize = sz;
            if (sz > maxSize) maxSize = sz;
        }

        var hasMixedSizes = (runs.length > 1 && maxSize > minSize + 4);
        var mText = String(ss.mText || "");
        var searchFrom = 0;

        for (var w = 0; w < words.length; w++) {
            var token = String(words[w]);
            var idx = mText.toLowerCase().indexOf(token.toLowerCase(), searchFrom);
            if (idx === -1) idx = searchFrom;
            searchFrom = idx + token.length;

            var activeSize = Number(runs[0][1]) || 56;
            for (var k = 0; k < runs.length; k++) {
                if (runs[k][0] <= idx) {
                    activeSize = Number(runs[k][1]) || 56;
                } else {
                    break;
                }
            }

            var activeColor = Number(colorRuns[0][1]) || 16777215;
            for (var ck = 0; ck < colorRuns.length; ck++) {
                if (colorRuns[ck][0] <= idx) {
                    activeColor = Number(colorRuns[ck][1]) || 16777215;
                } else {
                    break;
                }
            }

            if (
                activeSize >= 66 ||
                (hasMixedSizes && activeSize >= maxSize - 2) ||
                (activeColor !== 16777215 && activeColor !== 14540253)
            ) {
                accented.push(w);
            }
        }
    } catch (e) {}
    return accented;
}

function getTimelineSubSplitCues() {
    try {
        if (!app.project || !app.project.activeSequence) {
            return JSON.stringify({ error: "Нет активного таймлайна Premiere Pro" });
        }
        var seq = app.project.activeSequence;
        var bestTrackIdx = -1;
        var bestClips = [];

        for (var t = seq.videoTracks.numTracks - 1; t >= 1; t--) {
            var tr = seq.videoTracks[t];
            if (!tr || !tr.clips || tr.clips.numItems === 0) continue;
            var matched = [];
            for (var c = 0; c < tr.clips.numItems; c++) {
                var cl = tr.clips[c];
                if (cl && isSubSplitAnimClip(cl)) {
                    var decoded = decodeSubSplitClipName(cl.name);
                    var words = decoded.words;
                    var accIdx = decoded.accentIndices;

                    if (words.length === 0 || decoded.text === "Graphic" || decoded.text === "Apple Smooth Subtitle") {
                        var textProp = findTextComponentProp(cl);
                        var rawDoc = textProp ? String(textProp.getValue() || "") : "";
                        if (rawDoc.indexOf('0000{"mTextParam"') === 0) {
                            try {
                                var parsed = JSON.parse(rawDoc.slice(4));
                                var phrase = String(parsed.mTextParam.mStyleSheet.mText || "").replace(/[\r\n]+/g, " ");
                                words = splitPhraseIntoWords(phrase);
                                accIdx = detectAccentedWordIndicesFromDoc(words, rawDoc);
                            } catch (pe) {}
                        }
                    } else if (!decoded.isMarked) {
                        var textProp2 = findTextComponentProp(cl);
                        var rawDoc2 = textProp2 ? String(textProp2.getValue() || "") : "";
                        if (rawDoc2.indexOf('0000{"mTextParam"') === 0) {
                            accIdx = detectAccentedWordIndicesFromDoc(words, rawDoc2);
                        }
                    }

                    matched.push({
                        trackIndex: t,
                        clipIndex: c,
                        start: Math.round(cl.start.seconds * 100) / 100,
                        end: Math.round(cl.end.seconds * 100) / 100,
                        text: words.join(" "),
                        words: words,
                        accentIndices: accIdx
                    });
                }
            }
            if (matched.length > bestClips.length) {
                bestClips = matched;
                bestTrackIdx = t;
            }
        }

        if (bestTrackIdx === -1 || bestClips.length === 0) {
            return JSON.stringify({
                status: "empty",
                cues: [],
                message: "На таймлайне пока нет Graphic-субтитров SubSplit"
            });
        }

        return JSON.stringify({
            status: "success",
            trackIndex: bestTrackIdx,
            videoTrack: bestTrackIdx + 1,
            cues: bestClips
        });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

function updateSingleTimelineClipAccent(trackIdx, clipIdx, phraseText, accentIndicesJson, accentCfgJson) {
    try {
        if (!app.project || !app.project.activeSequence) {
            return JSON.stringify({ error: "Нет активного таймлайна" });
        }
        var seq = app.project.activeSequence;
        var resolvedTrackIdx = Number(trackIdx);
        if (isNaN(resolvedTrackIdx) || resolvedTrackIdx < 0 || !seq.videoTracks[resolvedTrackIdx]) {
            var fallbackInfo = JSON.parse(getTimelineSubSplitCues());
            if (fallbackInfo && typeof fallbackInfo.trackIndex === "number") {
                resolvedTrackIdx = fallbackInfo.trackIndex;
            }
        }

        var tr = seq.videoTracks[resolvedTrackIdx];
        if (!tr || !tr.clips || Number(clipIdx) >= tr.clips.numItems) {
            return JSON.stringify({ error: "Клип не найден на дорожке" });
        }

        var cl = tr.clips[Number(clipIdx)];
        var textProp = findTextComponentProp(cl);
        if (!textProp) {
            return JSON.stringify({ error: "Текстовый компонент не найден в клипе" });
        }

        var accentIndices = [];
        try {
            accentIndices = JSON.parse(accentIndicesJson || "[]");
        } catch (e1) {}

        var accentCfg = {};
        try {
            accentCfg = JSON.parse(accentCfgJson || "{}");
        } catch (e2) {}

        var cleanPhrase = String(phraseText || "").replace(/[\u200B\u2060\r\n]+/g, " ").replace(/^\s+|\s+$/g, "");
        if (!cleanPhrase) {
            cleanPhrase = decodeSubSplitClipName(cl.name).text;
        }
        var words = splitPhraseIntoWords(cleanPhrase);

        try {
            cl.name = encodeSubSplitClipName(words, accentIndices);
        } catch (nErr) {}

        var seqW = Number(seq.frameSizeHorizontal) || 1080;
        var seqH = Number(seq.frameSizeVertical) || 1920;

        var payload = buildAppleTextDocPayload(words.join(" "), false, seqW, seqH, accentIndices, accentCfg);
        textProp.setValue(payload, true);

        // Перемещаем плейхед на середину входа этого субтитра, чтобы пользователь сразу видел результат
        try {
            var previewT = new Time();
            var dur = Math.max(0.2, cl.end.seconds - cl.start.seconds);
            previewT.seconds = cl.start.seconds + Math.min(0.28, dur * 0.5);
            seq.setPlayerPosition(previewT.ticks);
        } catch (ctErr) {}

        return JSON.stringify({
            status: "success",
            trackIndex: resolvedTrackIdx,
            clipIndex: Number(clipIdx),
            accentIndices: accentIndices
        });
    } catch (err) {
        return JSON.stringify({ error: err.toString() });
    }
}

function batchUpdateTimelineAccents(mode, accentCfgJson) {
    try {
        if (!app.project || !app.project.activeSequence) {
            return JSON.stringify({ error: "Нет активного таймлайна" });
        }
        var infoRes = JSON.parse(getTimelineSubSplitCues());
        if (infoRes.status !== "success" || !infoRes.cues || infoRes.cues.length === 0) {
            return JSON.stringify({ error: "На таймлайне нет Graphic-субтитров для обновления" });
        }

        var accentCfg = {};
        try {
            accentCfg = JSON.parse(accentCfgJson || "{}");
        } catch (eCfg) {}

        var seq = app.project.activeSequence;
        var seqW = Number(seq.frameSizeHorizontal) || 1080;
        var seqH = Number(seq.frameSizeVertical) || 1920;
        var tr = seq.videoTracks[infoRes.trackIndex];
        var updatedCount = 0;
        var singleWordCooldown = 0;

        for (var i = 0; i < infoRes.cues.length; i++) {
            var cueInfo = infoRes.cues[i];
            var cl = tr.clips[cueInfo.clipIndex];
            if (!cl) continue;
            var textProp = findTextComponentProp(cl);
            if (!textProp) continue;

            var words = cueInfo.words || splitPhraseIntoWords(cueInfo.text);
            var targetAccents = cueInfo.accentIndices || [];

            if (mode === "auto") {
                targetAccents = [];
                if (words.length >= 2) {
                    var bestW = pickSmartAccentWordIndex(words);
                    if (bestW >= 0) targetAccents.push(bestW);
                } else if (words.length === 1) {
                    var cw1 = cleanWordForScore(words[0]);
                    if (singleWordCooldown <= 0 && cw1.length >= 6 && !STOPWORDS_ACCENT[cw1]) {
                        targetAccents.push(0);
                        singleWordCooldown = 2;
                    } else {
                        singleWordCooldown--;
                    }
                }
            } else if (mode === "clear") {
                targetAccents = [];
            }

            try {
                cl.name = encodeSubSplitClipName(words, targetAccents);
            } catch (nErr) {}

            var isLast = (i === infoRes.cues.length - 1);
            var payload = buildAppleTextDocPayload(words.join(" "), false, seqW, seqH, targetAccents, accentCfg);
            textProp.setValue(payload, isLast);
            updatedCount++;
        }

        var refreshed = JSON.parse(getTimelineSubSplitCues());
        refreshed.updatedCount = updatedCount;
        return JSON.stringify(refreshed);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

// Импорт SRT в проект и автоматическое создание дорожки субтитров на таймлайне
function importSrtToProject(srtPath, animStyle, isSecondaryTrack, avoidTrackIdx, accentCfgJson) {
    try {
        if (!app.project) {
            return JSON.stringify({ error: "Нет открытого проекта Premiere Pro." });
        }

        // Поддержка вызова с 3 аргументами: importSrtToProject(srtPath, animStyle, accentCfgJson)
        if (typeof isSecondaryTrack === "string" && isSecondaryTrack.indexOf("{") !== -1) {
            accentCfgJson = isSecondaryTrack;
            isSecondaryTrack = false;
            avoidTrackIdx = undefined;
        }

        neutralizeMisterHorseBugs();

        var fileObj = new File(srtPath);
        if (!fileObj.exists) {
            return JSON.stringify({ error: "Файл субтитров не найден на диске: " + srtPath });
        }

        var accentCfg = {};
        if (accentCfgJson && typeof accentCfgJson === "string" && accentCfgJson.length > 1) {
            try {
                accentCfg = JSON.parse(accentCfgJson);
            } catch (acErr) {}
        } else if (accentCfgJson && typeof accentCfgJson === "object") {
            accentCfg = accentCfgJson;
        }

        var success = false;
        var targetBin = null;

        try {
            targetBin = app.project.getInsertionBin();
        } catch (binErr) {
            targetBin = null;
        }

        if (!targetBin || targetBin === 0) {
            targetBin = app.project.rootItem;
        }

        var oldItem = findProjectItemByPath(fileObj.fsName);
        if (oldItem) {
            try {
                oldItem.refreshMedia();
            } catch (refErr) {}
        }

        try {
            neutralizeMisterHorseBugs();
            success = app.project.importFiles([fileObj.fsName], true, targetBin, false);
        } catch (e1) {
            success = false;
        }

        if (!success) {
            try {
                neutralizeMisterHorseBugs();
                success = app.project.importFiles([fileObj.fsName], true, app.project.rootItem, false);
            } catch (e2) {
                success = false;
            }
        }

        if (!success) {
            try {
                neutralizeMisterHorseBugs();
                success = app.project.importFiles([fileObj.fsName]);
            } catch (e3) {
                success = false;
            }
        }

        var projectItem = findProjectItemByPath(fileObj.fsName);
        if (projectItem) {
            success = true;
            try {
                projectItem.refreshMedia();
            } catch (refE) {}
        }

        if (!success || !projectItem) {
            return JSON.stringify({
                status: "saved_on_disk",
                error: "Файл сохранён в папке srt (" + fileObj.fsName + "). Перетащите его в проект вручную.",
                path: fileObj.fsName
            });
        }

        if (animStyle === "bin_only") {
            return JSON.stringify({
                status: "success",
                onTimeline: false,
                animated: false,
                message: "SRT импортирован в панель проекта (Bin).",
                path: fileObj.fsName
            });
        }

        // АВТОМАТИЧЕСКОЕ РАЗМЕЩЕНИЕ НА ТАЙМЛАЙНЕ
        var placedOnTimeline = false;
        var timelineDetails = "";
        var animatedResult = null;
        var useAnim = !!(animStyle && animStyle !== "none" && animStyle !== "");

        if (app.project.activeSequence) {
            var seq = app.project.activeSequence;

            if (useAnim) {
                try {
                    animatedResult = placeAnimatedGraphicSubtitles(
                        seq,
                        fileObj.fsName,
                        animStyle,
                        !!isSecondaryTrack,
                        avoidTrackIdx,
                        accentCfg
                    );
                    if (animatedResult && animatedResult.placed) {
                        placedOnTimeline = true;
                    } else if (animatedResult && animatedResult.reason) {
                        timelineDetails = animatedResult.reason;
                    }
                } catch (animEx) {
                    timelineDetails = animEx.toString();
                }
            }

            if (!placedOnTimeline) {
                if (typeof seq.createCaptionTrack === "function") {
                    try {
                        var res1 = seq.createCaptionTrack(projectItem, 0);
                        if (res1 !== false && typeof res1 !== "undefined") {
                            placedOnTimeline = true;
                        }
                    } catch (tErr1) {
                        try {
                            var res2 = seq.createCaptionTrack(projectItem, 0.0);
                            if (res2 !== false && typeof res2 !== "undefined") {
                                placedOnTimeline = true;
                            }
                        } catch (tErr2) {
                            try {
                                var res3 = seq.createCaptionTrack(projectItem, 0, "subtitle");
                                if (res3 !== false && typeof res3 !== "undefined") {
                                    placedOnTimeline = true;
                                }
                            } catch (tErr3) {
                                timelineDetails = tErr3.toString();
                            }
                        }
                    }
                }

                if (!placedOnTimeline) {
                    try {
                        if (typeof app.enableQE === "function") app.enableQE();
                        if (typeof qe !== "undefined" && qe && qe.project) {
                            var qeSeq = qe.project.getActiveSequence();
                            if (qeSeq && typeof qeSeq.createCaptionTrack === "function") {
                                var qeRes = qeSeq.createCaptionTrack(projectItem, 0);
                                if (qeRes !== false && typeof qeRes !== "undefined") {
                                    placedOnTimeline = true;
                                }
                            }
                        }
                    } catch (qeErr) {}
                }
            }
        } else {
            timelineDetails = "Нет активного таймлайна для размещения субтитров";
        }

        if (placedOnTimeline) {
            return JSON.stringify({
                status: "success",
                onTimeline: true,
                animated: !!(animatedResult && animatedResult.placed),
                animatedCount: (animatedResult && animatedResult.placedCount) ? animatedResult.placedCount : 0,
                videoTrack: (animatedResult && typeof animatedResult.trackIndex === "number") ? (animatedResult.trackIndex + 1) : null,
                animStyle: (animatedResult && animatedResult.placed) ? animStyle : "none",
                message: "Субтитры успешно созданы прямо на таймлайне!",
                path: fileObj.fsName
            });
        }

        return JSON.stringify({
            status: "success",
            onTimeline: false,
            message: "Субтитры успешно добавлены в проект (Bin)!",
            path: fileObj.fsName,
            details: timelineDetails
        });
    } catch (err) {
        var itemInBin = findProjectItemByPath(srtPath);
        if (itemInBin) {
            return JSON.stringify({
                status: "success",
                onTimeline: false,
                message: "Субтитры успешно импортированы в проект!",
                path: srtPath
            });
        }
        return JSON.stringify({
            status: "saved_on_disk",
            error: "Субтитры сохранены в папке srt: " + srtPath,
            path: srtPath
        });
    }
}

// Импорт двух параллельных дорожек субтитров (Перевод + Оригинальная речь)
function importDualSrtToTimeline(translateSrtPath, originalSrtPath, animStyle, accentCfgJson) {
    try {
        var resTranslate = null;
        var resOriginal = null;
        var primaryTrackZeroIdx = undefined;

        if (translateSrtPath && translateSrtPath.length > 0) {
            resTranslate = JSON.parse(importSrtToProject(translateSrtPath, animStyle, false, undefined, accentCfgJson));
            if (resTranslate && typeof resTranslate.videoTrack === "number") {
                primaryTrackZeroIdx = resTranslate.videoTrack - 1;
            }
        }

        if (originalSrtPath && originalSrtPath.length > 0) {
            resOriginal = JSON.parse(importSrtToProject(originalSrtPath, animStyle, true, primaryTrackZeroIdx, "{}"));
        }

        return JSON.stringify({
            status: "success",
            trackTranslate: resTranslate,
            trackOriginal: resOriginal
        });
    } catch (eDual) {
        return JSON.stringify({
            status: "error",
            error: "Ошибка импорта двух дорожек: " + eDual.toString()
        });
    }
}

// Показать всплывающее системное сообщение в Premiere
function showAlert(msg) {
    alert(msg);
}

// ==========================================================================
// Project Organizer Functions
// ==========================================================================

// Получение информации о корневой папке текущего проекта
function getProjectRootInfo() {
    try {
        if (!app.project) {
            return JSON.stringify({ error: "Нет открытого проекта Premiere Pro." });
        }
        var pPath = app.project.path;
        if (!pPath || pPath.length === 0) {
            return JSON.stringify({ error: "Проект еще не сохранен на диске. Пожалуйста, сохраните проект (Cmd+S)." });
        }
        var pFile = new File(pPath);
        if (pFile.exists && pFile.parent) {
            return JSON.stringify({
                status: "success",
                projectPath: pPath,
                projectDir: pFile.parent.fsName,
                projectName: pFile.name
            });
        }
        return JSON.stringify({ error: "Не удалось прочитать путь к файлу проекта." });
    } catch (e) {
        return JSON.stringify({ error: "Ошибка getProjectRootInfo: " + e.toString() });
    }
}

// Открытие системного диалога выбора папки
function selectFolderDialog(promptTitle) {
    try {
        var folder = Folder.selectDialog(promptTitle || "Выберите папку-библиотеку");
        if (folder) {
            return JSON.stringify({
                status: "success",
                path: folder.fsName
            });
        }
        return JSON.stringify({ status: "cancelled" });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

// Рекурсивный сбор всех элементов проекта (клипов, секвенций, графики)
function getProjectItemsManifest() {
    try {
        if (!app.project) {
            return JSON.stringify({ error: "Нет открытого проекта Premiere Pro." });
        }

        var pPath = app.project.path;
        var pDir = "";
        if (pPath && pPath.length > 0) {
            var pFile = new File(pPath);
            if (pFile.exists && pFile.parent) {
                pDir = pFile.parent.fsName;
            }
        }

        var itemsList = [];

        function walkProjectTree(parentItem, parentBin) {
            if (!parentItem || !parentItem.children) return;
            for (var i = 0; i < parentItem.children.numItems; i++) {
                var item = parentItem.children[i];
                if (!item) continue;

                var isSeq = false;
                try { isSeq = item.isSequence(); } catch (eSeq) {}

                var mPath = "";
                try { mPath = item.getMediaPath(); } catch (eMed) {}

                var isOffline = false;
                try { isOffline = item.isOffline(); } catch (eOff) {}

                if (item.type === 2) {
                    // Это бин - рекурсивно обходим его
                    walkProjectTree(item, item);
                } else {
                    // Это клип, секвенция, файл или синтетический слой
                    itemsList.push({
                        nodeId: item.nodeId,
                        name: item.name,
                        type: item.type, // 1: CLIP, 2: BIN, 3: ROOT, 4: FILE
                        isSequence: isSeq,
                        isOffline: isOffline,
                        mediaPath: mPath || "",
                        parentBinName: parentBin ? parentBin.name : ""
                    });
                }
            }
        }

        walkProjectTree(app.project.rootItem, null);

        return JSON.stringify({
            status: "success",
            projectDir: pDir,
            items: itemsList
        });
    } catch (e) {
        return JSON.stringify({ error: "Ошибка getProjectItemsManifest: " + e.toString() });
    }
}

// Поиск или создание бина первого уровня в проекте
function getOrCreateProjectBin(binName) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var child = root.children[i];
        if (child && child.type === 2 && child.name === binName) {
            return child;
        }
    }
    return root.createBin(binName);
}

// Применение плана организации: создание бинов, обновление путей (relink) и раскладка по бинам
function applyProjectOrganization(planJsonStr) {
    try {
        if (!app.project) {
            return JSON.stringify({ error: "Нет открытого проекта Premiere Pro." });
        }

        var plan = JSON.parse(planJsonStr);
        if (!plan || !plan.actions) {
            return JSON.stringify({ error: "Некорректный план организации." });
        }

        // 1. Создаем или получаем целевые бины
        var binsMap = {};
        if (plan.bins && plan.bins.length > 0) {
            for (var b = 0; b < plan.bins.length; b++) {
                var bName = plan.bins[b];
                binsMap[bName] = getOrCreateProjectBin(bName);
            }
        }

        // 2. Строим быстрый словарь элементов по nodeId
        var itemsDict = {};
        function indexTree(parentItem) {
            if (!parentItem || !parentItem.children) return;
            for (var i = 0; i < parentItem.children.numItems; i++) {
                var it = parentItem.children[i];
                if (!it) continue;
                itemsDict[it.nodeId] = it;
                if (it.type === 2) {
                    indexTree(it);
                }
            }
        }
        indexTree(app.project.rootItem);

        // 3. Выполняем действия
        var relinkCount = 0;
        var moveCount = 0;
        var errors = [];

        for (var a = 0; a < plan.actions.length; a++) {
            var action = plan.actions[a];
            var item = itemsDict[action.nodeId];
            if (!item) continue;

            // Обновление пути медиа (Relink)
            if (action.newMediaPath && action.newMediaPath.length > 0) {
                var curPath = "";
                try { curPath = item.getMediaPath(); } catch (eGet) {}
                if (curPath !== action.newMediaPath) {
                    try {
                        var relinkSuccess = item.changeMediaPath(action.newMediaPath, true);
                        if (relinkSuccess !== false) {
                            relinkCount++;
                        }
                    } catch (eRelink) {
                        errors.push("Relink " + item.name + ": " + eRelink.toString());
                    }
                }
            }

            // Перемещение в целевой бин
            if (action.targetBin && binsMap[action.targetBin]) {
                var targetBinObj = binsMap[action.targetBin];
                // Проверяем, не находится ли элемент уже в этом бине
                if (action.parentBinName !== action.targetBin) {
                    try {
                        item.moveBin(targetBinObj);
                        moveCount++;
                    } catch (eMove) {
                        errors.push("MoveBin " + item.name + ": " + eMove.toString());
                    }
                }
            }
        }

        return JSON.stringify({
            status: "success",
            relinkedCount: relinkCount,
            movedCount: moveCount,
            errors: errors
        });
    } catch (e) {
        return JSON.stringify({ error: "Ошибка applyProjectOrganization: " + e.toString() });
    }
}
