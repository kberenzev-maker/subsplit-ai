/**
 * SubSplit AI - Client Controller
 */

let csInterface = null;
let activeSeqData = null;
let isProcessing = false;
let currentProcess = null;
let activeTempWav = null;

let evalScriptCallCounter = 0;
function installCsInterfaceLogger(cs) {
    if (!cs || typeof cs.evalScript !== 'function' || cs._isLoggedWrapped) return;
    const originalEval = cs.evalScript.bind(cs);
    cs.evalScript = function(script, callback) {
        evalScriptCallCounter++;
        const callId = evalScriptCallCounter;
        const shortScript = script.length > 250 ? script.slice(0, 250) + '... [truncated]' : script;
        const cleanScript = shortScript.replace(/[\r\n\t]+/g, ' ').trim();
        const t0 = Date.now();
        if (window.SubSplitLogger) {
            window.SubSplitLogger.debug('EXTENDSCRIPT_CALL', `[#${callId}] ${cleanScript}`);
        }
        originalEval(script, function(result) {
            const elapsed = Date.now() - t0;
            const shortRes = result && result.length > 350 ? result.slice(0, 350) + '... [truncated]' : result;
            if (window.SubSplitLogger) {
                window.SubSplitLogger.debug('EXTENDSCRIPT_RESP', `[#${callId}] (${elapsed}ms) -> ${shortRes}`);
            }
            if (callback) {
                try {
                    callback(result);
                } catch (cbErr) {
                    if (window.SubSplitLogger) {
                        window.SubSplitLogger.error('EXTENDSCRIPT_CB_ERR', `Callback error for #${callId}: ${cbErr.message}`, cbErr.stack);
                    }
                    throw cbErr;
                }
            }
        });
    };
    cs._isLoggedWrapped = true;
}

function getCleanExtensionPath() {
    if (!csInterface) {
        if (typeof __dirname !== 'undefined') {
            const p = require('path');
            return path.resolve(__dirname, '..').replace(/\\/g, '/');
        }
        return '';
    }
    let raw = csInterface.getSystemPath(SystemPath.EXTENSION) || '';
    raw = raw.replace(/^file:\/\//i, '');
    try {
        raw = decodeURIComponent(raw);
    } catch (e) {}
    return raw.replace(/\\/g, '/');
}

window.addEventListener('DOMContentLoaded', () => {
    try {
        csInterface = new CSInterface();
        installCsInterfaceLogger(csInterface);
        const extPath = getCleanExtensionPath();
        csInterface.evalScript(`$.evalFile(${JSON.stringify(extPath + '/host/index.jsx')})`);
    } catch (e) {
        console.warn("CSInterface init error:", e);
    }

    setupEventListeners();
    setupOrganizerListeners();
    refreshSequenceInfo();
    refreshProjectInfo();
    renderProtectedFolders();
});

let activePunctChars = new Set();

function setupEventListeners() {
    // Переключение вкладок (Субтитры / Органайзер)
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTabId = btn.getAttribute('data-tab');
            document.querySelectorAll('.tab-btn').forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');

            const targetPane = document.getElementById(targetTabId);
            if (targetPane) targetPane.classList.add('active');

            if (targetTabId === 'tabOrganizer') {
                refreshProjectInfo();
                renderProtectedFolders();
            } else if (targetTabId === 'tabSubtitles') {
                refreshSequenceInfo();
            }
        });
    });

    document.getElementById('btnRefreshSeq').addEventListener('click', refreshSequenceInfo);
    document.getElementById('btnGenerate').addEventListener('click', onGenerateClick);
    document.getElementById('btnCancel').addEventListener('click', cancelProcessing);
    document.getElementById('btnClearLog').addEventListener('click', () => {
        document.getElementById('logBox').textContent = 'Лог очищен.';
    });
    const btnOpenLog = document.getElementById('btnOpenLogFile');
    if (btnOpenLog) {
        btnOpenLog.addEventListener('click', () => {
            if (window.SubSplitLogger) {
                window.SubSplitLogger.openLogFile();
            }
        });
    }

    // Переключение блока настроек перевода
    const checkTranslate = document.getElementById('checkTranslate');
    const translateBlock = document.getElementById('translateSettingsBlock');
    if (checkTranslate && translateBlock) {
        checkTranslate.addEventListener('change', () => {
            translateBlock.style.display = checkTranslate.checked ? 'flex' : 'none';
        });
    }

    // Обработка чипов удаления знаков препинания
    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const char = chip.getAttribute('data-char');
            if (char === 'all') {
                const wasActive = chip.classList.contains('active');
                if (wasActive) {
                    activePunctChars.clear();
                    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                } else {
                    activePunctChars = new Set(['all', '.', ',', '?', '!']);
                    document.querySelectorAll('.chip').forEach(c => c.classList.add('active'));
                }
            } else {
                if (activePunctChars.has(char)) {
                    activePunctChars.delete(char);
                    chip.classList.remove('active');
                    document.getElementById('chipAll').classList.remove('active');
                    activePunctChars.delete('all');
                } else {
                    activePunctChars.add(char);
                    chip.classList.add('active');
                    if (['.', ',', '?', '!'].every(c => activePunctChars.has(c))) {
                        activePunctChars.add('all');
                        document.getElementById('chipAll').classList.add('active');
                    }
                }
            }
            updatePunctStatus();
        });
    });

    function updateSliderTrack(slider) {
        if (!slider) return;
        const min = parseFloat(slider.min) || 0;
        const max = parseFloat(slider.max) || 100;
        const val = parseFloat(slider.value) || 0;
        const pct = ((val - min) / (max - min)) * 100;
        slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--bg-input) ${pct}%, var(--bg-input) 100%)`;
    }

    function setWordsValue(val) {
        const n = parseInt(val, 10) || 2;
        const slider = document.getElementById('maxWordsSlider');
        const hiddenInput = document.getElementById('maxWordsSelect');
        const badge = document.getElementById('maxWordsBadge');

        if (slider && parseInt(slider.value, 10) !== n) {
            slider.value = n;
        }
        if (slider) updateSliderTrack(slider);
        if (hiddenInput) hiddenInput.value = n;

        if (badge) {
            let label = `${n} слов`;
            if (n === 1) label = '1 слово · Word-by-word';
            else if (n === 2) label = '2 слова · Reels';
            else if (n === 3) label = '3 слова · Динамично';
            else if (n === 4) label = '4 слова · Фраза';
            else if (n >= 5 && n <= 7) label = `${n} слов`;
            else if (n >= 8) label = `${n} слов · Предложение`;
            badge.textContent = label;
        }

        document.querySelectorAll('#wordsTicksRow .slider-tick-label').forEach(t => {
            const tVal = parseInt(t.getAttribute('data-val'), 10);
            t.classList.toggle('active', tVal === n);
        });
    }

    function setLinesValue(val, triggerRestyle = false) {
        const n = parseInt(val, 10) || 2;
        const slider = document.getElementById('maxLinesSlider');
        const hiddenInput = document.getElementById('maxLinesSelect');
        const badge = document.getElementById('maxLinesBadge');

        if (slider && parseInt(slider.value, 10) !== n) {
            slider.value = n;
        }
        if (slider) updateSliderTrack(slider);
        if (hiddenInput) hiddenInput.value = n;

        if (badge) {
            const labels = {
                1: '1 строка · В одну линию',
                2: '2 строки · Оптимально',
                3: '3 строки · Развёрнуто'
            };
            badge.textContent = labels[n] || `${n} строки`;
        }

        document.querySelectorAll('#linesTicksRow .slider-tick-label').forEach(t => {
            const tVal = parseInt(t.getAttribute('data-val'), 10);
            t.classList.toggle('active', tVal === n);
        });

        // Управление чекбоксом "На отдельной строке"
        const stackWrapper = document.getElementById('stackLineWrapper');
        const checkStack = document.getElementById('checkAccentStackLine');
        const stackLabel = document.getElementById('stackLineLabel');
        if (n === 1) {
            if (stackWrapper) stackWrapper.classList.add('disabled');
            if (checkStack) {
                checkStack.disabled = true;
                checkStack.checked = false;
            }
            if (stackLabel) stackLabel.textContent = 'На отдельной строке (1 строка)';
        } else {
            if (stackWrapper) stackWrapper.classList.remove('disabled');
            if (checkStack) checkStack.disabled = false;
            if (stackLabel) stackLabel.textContent = 'На отдельной строке';
        }

        if (triggerRestyle && timelineAccentCues.length > 0) {
            batchUpdateTimelineAccentsFromUI('restyle');
        }
    }

    // Слушатели слайдера «Слов на экран»
    const wordsSlider = document.getElementById('maxWordsSlider');
    if (wordsSlider) {
        wordsSlider.addEventListener('input', (e) => setWordsValue(e.target.value));
        updateSliderTrack(wordsSlider);
    }

    // Слушатели слайдера «Строк субтитров»
    const linesSlider = document.getElementById('maxLinesSlider');
    if (linesSlider) {
        linesSlider.addEventListener('input', (e) => setLinesValue(e.target.value, false));
        linesSlider.addEventListener('change', (e) => setLinesValue(e.target.value, true));
        updateSliderTrack(linesSlider);
    }

    // Клик по меткам чисел под слайдерами
    document.querySelectorAll('#wordsTicksRow .slider-tick-label').forEach(t => {
        t.addEventListener('click', () => {
            const v = t.getAttribute('data-val');
            if (v) setWordsValue(v);
        });
    });

    document.querySelectorAll('#linesTicksRow .slider-tick-label').forEach(t => {
        t.addEventListener('click', () => {
            const v = t.getAttribute('data-val');
            if (v) setLinesValue(v, true);
        });
    });

    // Инициализация ползунков на старт (2 слова, 2 строки)
    setWordsValue(2);
    setLinesValue(2, false);

    // Обработка выбора регистра текста (Обычный, CAPS, строчные)
    document.querySelectorAll('.chip-opt').forEach(chip => {
        chip.addEventListener('click', () => {
            const val = chip.getAttribute('data-case');
            document.querySelectorAll('.chip-opt').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');

            const hiddenInput = document.getElementById('textCaseSelect');
            if (hiddenInput) hiddenInput.value = val;

            const statusEl = document.getElementById('textCaseStatusText');
            if (statusEl) {
                if (val === 'upper') statusEl.textContent = 'ВСЕ ПРОПИСНЫЕ';
                else if (val === 'lower') statusEl.textContent = 'все строчные';
                else statusEl.textContent = 'Как в речи';
            }
        });
    });

    // Обработка выбора модели Whisper (Turbo, Small, Medium)
    document.querySelectorAll('.chip-model').forEach(chip => {
        chip.addEventListener('click', () => {
            const val = chip.getAttribute('data-model');
            document.querySelectorAll('.chip-model').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');

            const hiddenInput = document.getElementById('whisperModel');
            if (hiddenInput) hiddenInput.value = val;

            const statusEl = document.getElementById('modelStatusText');
            if (statusEl) {
                if (val === 'large-v3-turbo') statusEl.textContent = 'Apple GPU · Turbo';
                else if (val === 'small') statusEl.textContent = 'Small · CPU';
                else if (val === 'medium') statusEl.textContent = 'Medium · CPU';
                else statusEl.textContent = val;
            }
        });
    });

    // Обработка выбора Apple Smooth Animation
    document.querySelectorAll('.chip-anim').forEach(chip => {
        chip.addEventListener('click', () => {
            const val = chip.getAttribute('data-anim');
            document.querySelectorAll('.chip-anim').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');

            const hiddenInput = document.getElementById('animStyleSelect');
            if (hiddenInput) hiddenInput.value = val;

            const statusEl = document.getElementById('animStatusText');
            if (statusEl) {
                const labels = {
                    'spring_pop': 'Spring Pop · iOS 18',
                    'blur_reveal': 'Live Lyrics · Blur',
                    'fluid_slide': 'Fluid Slide · Inertia',
                    'dynamic_bounce': 'Dynamic Pulse · Reels',
                    'none': 'Без анимации (SRT)'
                };
                statusEl.textContent = labels[val] || val;
            }
        });
    });

    // Обработка изменения выбора аудиодорожки
    const trackSelect = document.getElementById('audioTrackSelect');
    if (trackSelect) {
        trackSelect.addEventListener('change', updateTrackStatusText);
    }

    // ======================================================================
    // Captions Accent Words Listeners
    // ======================================================================
    const checkAutoAccent = document.getElementById('checkAutoAccent');
    const accentSettingsBlock = document.getElementById('accentSettingsBlock');
    if (checkAutoAccent && accentSettingsBlock) {
        checkAutoAccent.addEventListener('change', () => {
            accentSettingsBlock.style.display = checkAutoAccent.checked ? 'flex' : 'none';
        });
    }

    document.querySelectorAll('.chip-scale').forEach(chip => {
        chip.addEventListener('click', () => {
            const val = chip.getAttribute('data-scale');
            document.querySelectorAll('.chip-scale').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            const hiddenInput = document.getElementById('accentScaleSelect');
            if (hiddenInput) hiddenInput.value = val;
            if (timelineAccentCues.length > 0) {
                batchUpdateTimelineAccentsFromUI('restyle');
            }
        });
    });

    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            const val = swatch.getAttribute('data-color');
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            swatch.classList.add('active');
            const hiddenInput = document.getElementById('accentColorSelect');
            if (hiddenInput) hiddenInput.value = val;
            if (timelineAccentCues.length > 0) {
                batchUpdateTimelineAccentsFromUI('restyle');
            }
        });
    });

    const checkAccentStackLine = document.getElementById('checkAccentStackLine');
    if (checkAccentStackLine) {
        checkAccentStackLine.addEventListener('change', () => {
            if (timelineAccentCues.length > 0) {
                batchUpdateTimelineAccentsFromUI('restyle');
            }
        });
    }

    const checkAccentUpper = document.getElementById('checkAccentUpper');
    if (checkAccentUpper) {
        checkAccentUpper.addEventListener('change', () => {
            if (timelineAccentCues.length > 0) {
                batchUpdateTimelineAccentsFromUI('restyle');
            }
        });
    }

    const btnLoadTimelineWords = document.getElementById('btnLoadTimelineWords');
    if (btnLoadTimelineWords) {
        btnLoadTimelineWords.addEventListener('click', () => {
            loadTimelineCuesForAccentEditor(true);
        });
    }

    const btnAutoAccentTimeline = document.getElementById('btnAutoAccentTimeline');
    if (btnAutoAccentTimeline) {
        btnAutoAccentTimeline.addEventListener('click', () => {
            batchUpdateTimelineAccentsFromUI('auto');
        });
    }

    const btnClearAccentTimeline = document.getElementById('btnClearAccentTimeline');
    if (btnClearAccentTimeline) {
        btnClearAccentTimeline.addEventListener('click', () => {
            batchUpdateTimelineAccentsFromUI('clear');
        });
    }

    // Подгружаем субтитры с активного таймлайна при старте панели
    setTimeout(() => {
        loadTimelineCuesForAccentEditor(false);
    }, 600);
}

let timelineAccentCues = [];
let activeAccentTrackIndex = -1;

function getAccentConfig() {
    const checkAutoAccent = document.getElementById('checkAutoAccent');
    const scaleEl = document.getElementById('accentScaleSelect');
    const colorEl = document.getElementById('accentColorSelect');
    const stackEl = document.getElementById('checkAccentStackLine');
    const upperEl = document.getElementById('checkAccentUpper');
    const linesEl = document.getElementById('maxLinesSelect') || document.getElementById('maxLinesSlider');

    const maxLines = linesEl ? (parseInt(linesEl.value, 10) || 2) : 2;
    const isEnabled = checkAutoAccent ? checkAutoAccent.checked : true;
    return {
        enabled: isEnabled,
        autoAccent: isEnabled,
        scaleRatio: scaleEl ? parseFloat(scaleEl.value) || 1.75 : 1.75,
        colorHex: colorEl ? colorEl.value : '#FFD60A',
        stackLine: (maxLines > 1 && stackEl) ? stackEl.checked : false,
        upperCase: upperEl ? upperEl.checked : true,
        maxLines: maxLines
    };
}

function formatShortTimecode(sec) {
    if (typeof sec !== 'number' || isNaN(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1);
    const mStr = m < 10 ? '0' + m : '' + m;
    const sStr = parseFloat(s) < 10 ? '0' + s : '' + s;
    return `${mStr}:${sStr}`;
}

function loadTimelineCuesForAccentEditor(verboseLog) {
    if (!csInterface) return;
    const extPath = getCleanExtensionPath();
    csInterface.evalScript(`$.evalFile(${JSON.stringify(extPath + '/host/index.jsx')}); getTimelineSubSplitCues()`, (resStr) => {
        try {
            const res = JSON.parse(resStr);
            const cueBadge = document.getElementById('accentCueBadge');
            if (res && res.status === 'success' && Array.isArray(res.cues)) {
                activeAccentTrackIndex = (typeof res.trackIndex === 'number') ? res.trackIndex : -1;
                timelineAccentCues = res.cues.map(c => ({
                    ...c,
                    trackIndex: (typeof c.trackIndex === 'number') ? c.trackIndex : activeAccentTrackIndex
                }));
                if (cueBadge) {
                    cueBadge.textContent = `${timelineAccentCues.length} фраз`;
                }
                renderAccentPhrasesList();
                if (verboseLog) {
                    log(`🎯 Загружено фраз с таймлайна V${res.trackIndex + 1}: ${res.cues.length}. Кликайте по словам для акцента!`);
                }
            } else {
                if (cueBadge) {
                    cueBadge.textContent = '0 фраз';
                }
                if (verboseLog && res && res.error) {
                    log(`ℹ️ ${res.error}`);
                }
            }
        } catch (e) {
            const cueBadge = document.getElementById('accentCueBadge');
            if (cueBadge) cueBadge.textContent = '0 фраз';
            if (verboseLog) {
                log(`ℹ️ На активном таймлайне пока нет Graphic-субтитров SubSplit.`);
            }
        }
    });
}

function renderAccentPhrasesList() {
    const listEl = document.getElementById('accentPhrasesList');
    if (!listEl) return;

    const prevScroll = listEl.scrollTop;
    listEl.innerHTML = '';
    if (!timelineAccentCues || timelineAccentCues.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'accent-phrases-empty';
        empty.textContent = 'На таймлайне пока нет Graphic-субтитров. Создайте субтитры или нажмите «С таймлайна».';
        listEl.appendChild(empty);
        return;
    }

    const cfg = getAccentConfig();
    const accentColor = cfg.colorHex || '#FFD60A';

    timelineAccentCues.forEach((cue, cueIdx) => {
        const row = document.createElement('div');
        row.className = 'accent-phrase-row';

        const tc = document.createElement('span');
        tc.className = 'accent-phrase-tc';
        tc.textContent = formatShortTimecode(cue.start);
        row.appendChild(tc);

        const wordsWrap = document.createElement('div');
        wordsWrap.className = 'accent-phrase-words';

        const words = Array.isArray(cue.words) ? cue.words : String(cue.text || '').split(/\s+/).filter(Boolean);
        const accentedSet = new Set(Array.isArray(cue.accentIndices) ? cue.accentIndices.map(Number) : []);

        words.forEach((w, wordIdx) => {
            const pill = document.createElement('button');
            pill.type = 'button';
            const isAcc = accentedSet.has(wordIdx);
            pill.className = 'word-accent-pill' + (isAcc ? ' active' : '');
            if (isAcc) {
                pill.style.borderColor = accentColor;
                pill.style.color = accentColor;
            }
            const displayWord = (isAcc && cfg.upperCase) ? String(w).toUpperCase() : String(w);
            pill.textContent = isAcc ? `✦ ${displayWord}` : displayWord;
            pill.title = isAcc ? 'Убрать крупный акцент со слова' : 'Сделать слово крупным акцентным (Captions)';
            pill.addEventListener('click', () => {
                onWordAccentToggle(cueIdx, wordIdx);
            });
            wordsWrap.appendChild(pill);
        });

        row.appendChild(wordsWrap);
        listEl.appendChild(row);
    });

    listEl.scrollTop = prevScroll;
}

function onWordAccentToggle(cueIdx, wordIdx) {
    const cue = timelineAccentCues[cueIdx];
    if (!cue || !csInterface) return;

    const current = Array.isArray(cue.accentIndices) ? cue.accentIndices.map(Number) : [];
    const pos = current.indexOf(wordIdx);
    const isNowAccented = (pos === -1);
    if (pos !== -1) {
        current.splice(pos, 1);
    } else {
        current.push(wordIdx);
        current.sort((a, b) => a - b);
    }
    cue.accentIndices = current;
    renderAccentPhrasesList();

    const cfg = getAccentConfig();
    const phraseClean = (Array.isArray(cue.words) && cue.words.length > 0) ? cue.words.join(' ') : String(cue.text || '').replace(/\s+/g, ' ').trim();
    const indicesJson = JSON.stringify(current);
    const cfgJson = JSON.stringify(cfg);
    const trackIdx = (typeof cue.trackIndex === 'number' && !isNaN(cue.trackIndex)) ? cue.trackIndex : activeAccentTrackIndex;
    const extPath = getCleanExtensionPath();

    const scriptCall = `$.evalFile(${JSON.stringify(extPath + '/host/index.jsx')}); updateSingleTimelineClipAccent(${trackIdx}, ${cue.clipIndex}, ${JSON.stringify(phraseClean)}, ${JSON.stringify(indicesJson)}, ${JSON.stringify(cfgJson)})`;
    csInterface.evalScript(scriptCall, (resStr) => {
        try {
            const res = JSON.parse(resStr);
            if (res && res.status === 'success') {
                if (typeof res.trackIndex === 'number') {
                    cue.trackIndex = res.trackIndex;
                    activeAccentTrackIndex = res.trackIndex;
                }
                const wordsArr = Array.isArray(cue.words) ? cue.words : phraseClean.split(' ');
                const clickedWord = wordsArr[wordIdx] || phraseClean;
                const accentedWords = current.map(i => wordsArr[i]).filter(Boolean);
                if (accentedWords.length > 0) {
                    setStatus(`Акцент: ${accentedWords.join(', ')} ✨`, 'ready');
                    log(`🎯 [${formatShortTimecode(cue.start)}] Крупный акцент (${cfg.scaleRatio}×): «${String(clickedWord).toUpperCase()}»`);
                } else {
                    setStatus('Акцент снят', 'ready');
                    log(`↩️ [${formatShortTimecode(cue.start)}] Снят акцент со слова «${clickedWord}»`);
                }
            } else if (res && res.error) {
                log(`⚠️ Ошибка обновления слова: ${res.error}`);
            }
        } catch (e) {}
    });
}

function batchUpdateTimelineAccentsFromUI(mode) {
    if (!csInterface) return;
    const cfg = getAccentConfig();
    const cfgJson = JSON.stringify(cfg);
    const extPath = getCleanExtensionPath();

    csInterface.evalScript(`$.evalFile(${JSON.stringify(extPath + '/host/index.jsx')}); batchUpdateTimelineAccents(${JSON.stringify(mode)}, ${JSON.stringify(cfgJson)})`, (resStr) => {
        try {
            const res = JSON.parse(resStr);
            if (res && res.status === 'success') {
                if (Array.isArray(res.cues)) {
                    activeAccentTrackIndex = (typeof res.trackIndex === 'number') ? res.trackIndex : activeAccentTrackIndex;
                    timelineAccentCues = res.cues.map(c => ({
                        ...c,
                        trackIndex: (typeof c.trackIndex === 'number') ? c.trackIndex : activeAccentTrackIndex
                    }));
                    renderAccentPhrasesList();
                } else {
                    loadTimelineCuesForAccentEditor(false);
                }
                const count = res.updatedCount || (res.cues ? res.cues.length : 0);
                if (mode === 'auto') {
                    log(`⚡ Авто-акцент Captions применён к ${count} фразам на таймлайне!`);
                    setStatus('Авто-акцент готов! ✨', 'ready');
                } else if (mode === 'clear') {
                    log(`🔄 Крупный акцент сброшен на ${count} фразах.`);
                    setStatus('Акценты сброшены', 'ready');
                } else {
                    setStatus(`Стиль акцентов обновлён ✨`, 'ready');
                }
            }
        } catch (e) {}
    });
}

function updateTrackStatusText() {
    const trackSelect = document.getElementById('audioTrackSelect');
    const trackStatus = document.getElementById('trackStatusText');
    if (!trackSelect || !trackStatus) return;
    if (trackSelect.value === 'all') {
        trackStatus.textContent = 'Микс дорожек';
        trackStatus.style.color = 'var(--warning)';
    } else {
        const optText = trackSelect.selectedOptions[0] ? trackSelect.selectedOptions[0].textContent : 'A1';
        trackStatus.textContent = `Изоляция: ${optText.split(' ')[0]}`;
        trackStatus.style.color = 'var(--text-secondary)';
    }
}

function updatePunctStatus() {
    const statusText = document.getElementById('punctStatusText');
    if (activePunctChars.size === 0) {
        statusText.textContent = 'Все знаки сохранены';
        statusText.style.color = 'var(--text-secondary)';
    } else if (activePunctChars.has('all')) {
        statusText.textContent = 'Удаляются все знаки';
        statusText.style.color = 'var(--danger)';
    } else {
        const list = Array.from(activePunctChars).filter(c => c !== 'all').join(' ');
        statusText.textContent = `Удаляются: ${list}`;
        statusText.style.color = 'var(--danger)';
    }
}

function refreshSequenceInfo() {
    const seqNameEl = document.getElementById('seqName');
    seqNameEl.textContent = 'Проверка...';

    if (!csInterface) {
        seqNameEl.textContent = 'Режим браузера (тест)';
        return;
    }

    const indicatorEl = document.getElementById('seqIndicator');
    if (indicatorEl) {
        indicatorEl.style.backgroundColor = 'var(--warning)';
        indicatorEl.style.boxShadow = '0 0 6px rgba(255, 159, 10, 0.6)';
    }

    csInterface.evalScript('getActiveSequenceInfo()', (resStr) => {
        try {
            const data = JSON.parse(resStr);
            if (data.error) {
                seqNameEl.textContent = data.error;
                seqNameEl.title = data.error;
                activeSeqData = null;
                if (indicatorEl) {
                    indicatorEl.style.backgroundColor = 'var(--danger)';
                    indicatorEl.style.boxShadow = '0 0 6px rgba(255, 69, 58, 0.6)';
                }
            } else {
                seqNameEl.textContent = data.sequenceName || 'Активный таймлайн';
                seqNameEl.title = data.sequenceName || 'Активный таймлайн';
                activeSeqData = data;
                if (indicatorEl) {
                    indicatorEl.style.backgroundColor = 'var(--success)';
                    indicatorEl.style.boxShadow = '0 0 6px rgba(48, 209, 88, 0.6)';
                }
                log(`Обнаружен таймлайн: ${data.sequenceName}`);
            }
        } catch (e) {
            seqNameEl.textContent = 'Не удалось связаться с Premiere';
            if (indicatorEl) {
                indicatorEl.style.backgroundColor = 'var(--danger)';
                indicatorEl.style.boxShadow = '0 0 6px rgba(255, 69, 58, 0.6)';
            }
        }
    });

    // Загружаем список аудиотреков секвенции для выбора дорожки с голосом
    csInterface.evalScript('getAudioTracksList()', (tracksStr) => {
        try {
            const res = JSON.parse(tracksStr);
            if (res.tracks && res.tracks.length > 0) {
                const select = document.getElementById('audioTrackSelect');
                if (!select) return;
                select.innerHTML = '';

                let defaultPicked = false;
                res.tracks.forEach((t) => {
                    const opt = document.createElement('option');
                    opt.value = t.index.toString();
                    const clipInfo = t.numClips > 0 ? ` (${t.numClips} кл.)` : ' (пусто)';
                    opt.textContent = `${t.name}${clipInfo}`;
                    if (!defaultPicked && t.numClips > 0) {
                        opt.selected = true;
                        defaultPicked = true;
                    }
                    select.appendChild(opt);
                });

                // Опция Микс
                const optMix = document.createElement('option');
                optMix.value = 'all';
                optMix.textContent = 'Все дорожки (Микс с музыкой)';
                select.appendChild(optMix);

                updateTrackStatusText();
            }
        } catch (e) {}
    });
}

function log(msg) {
    const logBox = document.getElementById('logBox');
    logBox.textContent += '\n' + msg;
    logBox.scrollTop = logBox.scrollHeight;
}

function setStatus(text, type = 'ready') {
    const badge = document.getElementById('statusBadge');
    badge.textContent = text;
    badge.className = `status-badge status-${type}`;
}

function setProgress(pct) {
    const bar = document.getElementById('progressBar');
    const container = document.getElementById('progressContainer');
    container.style.display = 'block';
    bar.style.width = `${pct}%`;
}

function hideProgress() {
    document.getElementById('progressContainer').style.display = 'none';
}

function findBackendPaths() {
    const fs = require('fs');
    const path = require('path');

    const candidates = [];

    // 1. Через csInterface.getSystemPath
    if (csInterface) {
        try {
            const p = csInterface.getSystemPath(SystemPath.EXTENSION);
            if (p) {
                candidates.push(p);
                candidates.push(path.join(p, '..'));
                try {
                    const real = fs.realpathSync(p);
                    if (real && real !== p) candidates.push(real);
                } catch (e0) {}
            }
        } catch (e) {}
    }

    // 2. Относительно __dirname (Node.js в CEP)
    if (typeof __dirname !== 'undefined') {
        candidates.push(__dirname);
        candidates.push(path.resolve(__dirname, '..'));
        candidates.push(path.join(__dirname, '..', 'com.antigravity.subsplit'));
        candidates.push(path.join(__dirname, 'com.antigravity.subsplit'));
        try {
            const realDir = fs.realpathSync(__dirname);
            if (realDir) {
                candidates.push(realDir);
                candidates.push(path.resolve(realDir, '..'));
            }
        } catch (e0) {}
    }

    // 3. Динамические системные пути (macOS / Windows)
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) {
        candidates.push(path.join(homeDir, 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', 'com.antigravity.subsplit'));
        candidates.push(path.join(homeDir, 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', 'com.antigravity.subsplit'));
        candidates.push(path.join(homeDir, 'Documents', 'antigravity', 'lively-hertz'));
    }

    const isWin = process.platform === 'win32';

    // Поиск рабочего venv и main.py
    for (const dir of candidates) {
        if (!dir) continue;
        const pyCandidates = [
            path.join(dir, 'backend', 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python'),
            path.join(dir, 'backend', 'venv', 'bin', 'python'),
            path.join(dir, 'backend', 'venv', 'Scripts', 'python.exe')
        ];
        const script = path.join(dir, 'backend', 'main.py');

        for (const py of pyCandidates) {
            if (fs.existsSync(py) && fs.existsSync(script)) {
                return { pythonBin: py, scriptPath: script, extDir: dir };
            }
        }
    }

    // Если venv еще не создан, но main.py существует, берем путь к будущему venv
    for (const dir of candidates) {
        if (!dir) continue;
        const script = path.join(dir, 'backend', 'main.py');
        if (fs.existsSync(script)) {
            const defaultPy = path.join(dir, 'backend', 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
            return { pythonBin: defaultPy, scriptPath: script, extDir: dir };
        }
    }

    const fallbackDir = candidates[0] || (typeof __dirname !== 'undefined' ? path.resolve(__dirname, '..') : '');
    return {
        pythonBin: path.join(fallbackDir, 'backend', 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python'),
        scriptPath: path.join(fallbackDir, 'backend', 'main.py'),
        extDir: fallbackDir
    };
}

function cancelProcessing() {
    if (currentProcess && isProcessing) {
        log('Отмена пользователем... Остановка процесса.');
        currentProcess.kill('SIGINT');
        setTimeout(() => {
            if (currentProcess) currentProcess.kill('SIGKILL');
        }, 1000);
        setStatus('Отменено', 'error');
        resetUI();
    }
}

function resetUI() {
    isProcessing = false;
    currentProcess = null;
    document.getElementById('btnGenerate').disabled = false;
    document.getElementById('btnCancel').style.display = 'none';
    hideProgress();

    if (activeTempWav) {
        try {
            const fs = require('fs');
            if (fs.existsSync(activeTempWav)) {
                fs.unlinkSync(activeTempWav);
            }
            const cutsFile = activeTempWav + '.cuts.json';
            if (fs.existsSync(cutsFile)) {
                fs.unlinkSync(cutsFile);
            }
        } catch (e) {}
        activeTempWav = null;
    }
}

async function onGenerateClick() {
    if (isProcessing) return;

    // Параметры
    const modelEl = document.getElementById('whisperModel');
    const model = modelEl ? modelEl.value : 'large-v3-turbo';
    const checkProofreadEl = document.getElementById('checkProofread');
    const useProofread = checkProofreadEl ? checkProofreadEl.checked : true;
    const checkOllamaEl = document.getElementById('checkOllama');
    const useOllama = checkOllamaEl ? checkOllamaEl.checked : false;

    const isTranslate = document.getElementById('checkTranslate') ? document.getElementById('checkTranslate').checked : false;
    const srcLang = document.getElementById('srcLangSelect') ? document.getElementById('srcLangSelect').value : 'auto';
    const tgtLang = document.getElementById('tgtLangSelect') ? document.getElementById('tgtLangSelect').value : 'ru';
    const isDualTrack = document.getElementById('checkDualTrack') ? document.getElementById('checkDualTrack').checked : true;
    const translateOptions = { isTranslate, srcLang, tgtLang, isDualTrack };

    const maxWordsEl = document.getElementById('maxWordsSelect');
    const maxWords = maxWordsEl ? maxWordsEl.value : '2';

    const maxLinesEl = document.getElementById('maxLinesSelect') || document.getElementById('maxLinesSlider');
    const maxLines = maxLinesEl ? maxLinesEl.value : '2';

    const textCaseEl = document.getElementById('textCaseSelect');
    const textCase = textCaseEl ? textCaseEl.value : 'default';

    const removeChars = activePunctChars.has('all') 
        ? 'all' 
        : Array.from(activePunctChars).filter(c => c !== 'all').join('');

    const path = require('path');
    const os = require('os');
    const tempSeqWav = path.join(os.tmpdir(), `seq_audio_${Date.now()}.wav`).replace(/\\/g, '/');
    activeTempWav = tempSeqWav;

    const trackSelect = document.getElementById('audioTrackSelect');
    const selectedTrack = trackSelect ? trackSelect.value : '0';
    const trackText = trackSelect && trackSelect.selectedOptions[0] ? trackSelect.selectedOptions[0].textContent : 'A1';

    isProcessing = true;
    document.getElementById('btnGenerate').disabled = true;
    document.getElementById('btnCancel').style.display = 'block';
    setStatus('Изоляция звука...', 'busy');
    log(`Экспорт аудио: изолируем ${trackText} (музыка и спецэффекты заглушены)...`);

    if (!csInterface) {
        alert('Нет соединения с Premiere Pro.');
        resetUI();
        return;
    }

    csInterface.evalScript(`exportActiveSequenceAudio("${tempSeqWav}", "${selectedTrack}")`, (resStr) => {
        try {
            const res = JSON.parse(resStr);
            if (res.error) {
                log(`⚠️ Предупреждение прямого экспорта секвенции: ${res.error}`);
                if (activeSeqData && activeSeqData.firstMediaPath) {
                    log('Fallback: используется исходный медиаклип.');
                    startProcessing(activeSeqData.firstMediaPath, 'transcribe', model, useProofread, useOllama, maxWords, maxLines, textCase, removeChars, translateOptions);
                } else {
                    alert(res.error);
                    resetUI();
                }
            } else {
                log(`✅ Чистая дорожка голоса (${trackText}) со всеми склейками готова: ${res.wavPath}`);
                startProcessing(res.wavPath, 'transcribe', model, useProofread, useOllama, maxWords, maxLines, textCase, removeChars, translateOptions);
            }
        } catch (e) {
            log(`Ошибка: ${e}`);
            if (activeSeqData && activeSeqData.firstMediaPath) {
                startProcessing(activeSeqData.firstMediaPath, 'transcribe', model, useProofread, useOllama, maxWords, maxLines, textCase, removeChars, translateOptions);
            } else {
                resetUI();
            }
        }
    });
}

function generateSrtName(srtDir, seqName, suffix = '') {
    const fs = require('fs');
    const cleanSeq = (seqName || 'Subtitles')
        .replace(/[/\\?%*:|"<>]/g, '_')
        .trim();

    let maxVersion = 0;
    try {
        if (fs.existsSync(srtDir)) {
            const files = fs.readdirSync(srtDir);
            const baseFile = `${cleanSeq}.srt`.toLowerCase();
            if (files.some(f => f.toLowerCase() === baseFile)) {
                maxVersion = 1;
            }

            const escaped = cleanSeq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const vRegex = new RegExp(`^${escaped}_v(\\d+)`, 'i');
            for (const f of files) {
                const m = f.match(vRegex);
                if (m) {
                    const vNum = parseInt(m[1], 10);
                    if (!isNaN(vNum) && vNum > maxVersion) {
                        maxVersion = vNum;
                    }
                }
            }
        }
    } catch (e) {}

    const nextVersion = maxVersion + 1;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}`;

    const tag = suffix ? `_${suffix}` : '';
    // Формат: Sequence 01_v2_04-49_Translate_RU.srt
    return `${cleanSeq}_v${nextVersion}_${timeStr}${tag}.srt`;
}

function resolveProjectSrtPath(inputMedia, translateOptions, callback) {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');

    const suffix = (translateOptions && translateOptions.isTranslate)
        ? `Translate_${translateOptions.tgtLang.toUpperCase()}`
        : '';

    function fallback() {
        let baseDir = '';
        if (inputMedia && fs.existsSync(inputMedia)) {
            baseDir = path.dirname(inputMedia);
        } else {
            baseDir = os.homedir();
        }
        const srtDir = path.join(baseDir, 'srt');
        try {
            if (!fs.existsSync(srtDir)) fs.mkdirSync(srtDir, { recursive: true });
            const fileName = generateSrtName(srtDir, 'Subtitles', suffix);
            return path.join(srtDir, fileName);
        } catch (e) {
            return path.join(os.tmpdir(), `Subtitles_${Date.now()}.srt`);
        }
    }

    if (!csInterface) {
        callback(fallback());
        return;
    }

    csInterface.evalScript('getProjectSrtFolder()', (resStr) => {
        try {
            const res = JSON.parse(resStr);
            if (res && res.status === 'success' && res.srtDir) {
                const seqName = res.sequenceName || 'Subtitles';
                const fileName = generateSrtName(res.srtDir, seqName, suffix);
                const target = path.join(res.srtDir, fileName);
                callback(target);
                return;
            }
        } catch (e) {}
        callback(fallback());
    });
}

function startProcessing(inputMedia, modeArg, model, useProofread, useOllama, maxWords, maxLines, textCase, removeChars, translateOptions) {
    isProcessing = true;
    document.getElementById('btnGenerate').disabled = true;
    document.getElementById('btnCancel').style.display = 'block';
    setStatus('Запуск...', 'busy');
    setProgress(5);

    resolveProjectSrtPath(inputMedia, translateOptions, (outputSrt) => {
        runPythonSubsplit(inputMedia, outputSrt, modeArg, model, useProofread, useOllama, maxWords, maxLines, textCase, removeChars, translateOptions);
    });
}

function runPythonSubsplit(inputMedia, outputSrt, modeArg, model, useProofread, useOllama, maxWords, maxLines, textCase, removeChars, translateOptions) {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const { spawn } = require('child_process');

    const backend = findBackendPaths();
    const pythonBin = backend.pythonBin;
    const scriptPath = backend.scriptPath;

    if (!fs.existsSync(pythonBin)) {
        log(`КРИТИЧЕСКАЯ ОШИБКА: Python не найден по пути: ${pythonBin}`);
        setStatus('Ошибка Python', 'error');
        resetUI();
        return;
    }

    const animEl = document.getElementById('animStyleSelect');
    const animStyle = animEl ? animEl.value : 'spring_pop';

    log(`Запуск генерации субтитров...\nСохранение: ${outputSrt}\nСлов на экран: ${maxWords}\nСтрок: ${maxLines}\nРегистр: ${textCase}\nАнимация: ${animStyle}`);

    const args = [
        scriptPath,
        '--mode', modeArg,
        '--input', inputMedia,
        '--output', outputSrt,
        '--max-words', maxWords ? maxWords.toString() : '2',
        '--max-lines', maxLines ? maxLines.toString() : '2',
        '--model', model,
        '--lang', 'ru',
        '--text-case', textCase || 'default'
    ];

    if (removeChars) {
        args.push('--remove-chars', removeChars);
    }

    if (!useProofread) {
        args.push('--no-proofread');
    }
    if (useOllama) {
        args.push('--use-ollama');
    }

    // Параметры мультиязычного перевода
    if (translateOptions && translateOptions.isTranslate) {
        args.push('--translate');
        args.push('--src-lang', translateOptions.srcLang || 'auto');
        args.push('--tgt-lang', translateOptions.tgtLang || 'ru');
        if (translateOptions.isDualTrack) {
            args.push('--dual-track');
        }
        log(`🌐 Включен режим перевода: [${translateOptions.srcLang}] ➔ [${translateOptions.tgtLang}]`);
        if (translateOptions.isDualTrack) {
            log(`📑 Будет сгенерировано 2 дорожки: перевод и оригинальная речь`);
        }
    }

    // Обязательно передаем полный PATH с homebrew для ffmpeg
    const env = Object.assign({}, process.env, {
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`
    });

    if (window.SubSplitLogger) {
        window.SubSplitLogger.info('PYTHON_SPAWN', `${pythonBin} ${args.join(' ')}`, {
            input: inputMedia,
            output: outputSrt,
            mode: modeArg,
            model: model,
            maxWords: maxWords,
            animStyle: animStyle,
            translateOptions: translateOptions
        });
    }

    const pyProcess = spawn(pythonBin, args, { env: env });
    currentProcess = pyProcess;

    pyProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (window.SubSplitLogger) {
                window.SubSplitLogger.debug('PYTHON_STDOUT', trimmed);
            }

            if (trimmed.startsWith('PROGRESS:')) {
                const pct = parseInt(trimmed.replace('PROGRESS:', ''));
                if (!isNaN(pct)) setProgress(pct);
            } else if (trimmed.startsWith('STATUS:')) {
                const statusMsg = trimmed.replace('STATUS:', '');
                log(statusMsg);
                setStatus(statusMsg.slice(0, 25) + '...', 'busy');
            } else if (trimmed.startsWith('SUCCESS_DUAL:')) {
                const parts = trimmed.replace('SUCCESS_DUAL:', '').split('|');
                onSuccessDual(parts[0], parts[1]);
            } else if (trimmed.startsWith('SUCCESS:')) {
                const srtPath = trimmed.replace('SUCCESS:', '');
                onSuccess(srtPath);
            } else if (trimmed.startsWith('ERROR:')) {
                log(`❌ ОШИБКА: ${trimmed.replace('ERROR:', '')}`);
                setStatus('Ошибка', 'error');
            } else {
                log(trimmed);
            }
        }
    });

    pyProcess.stderr.on('data', (data) => {
        const errStr = data.toString();
        if (window.SubSplitLogger) {
            window.SubSplitLogger.warn('PYTHON_STDERR', errStr.trim());
        }
        // Фильтруем служебные предупреждения python, но показываем реальные ошибки
        if (errStr.includes('Error') || errStr.includes('Exception') || errStr.includes('Traceback')) {
            log(`[Системная ошибка]:\n${errStr.trim()}`);
            setStatus('Ошибка', 'error');
        } else if (!errStr.includes('UserWarning') && !errStr.includes('FutureWarning')) {
            console.warn(errStr);
        }
    });

    pyProcess.on('error', (err) => {
        if (window.SubSplitLogger) {
            window.SubSplitLogger.error('PYTHON_PROCESS_ERR', err.message, err.stack);
        }
        log(`Не удалось запустить процесс: ${err.message}`);
        setStatus('Сбой', 'error');
        resetUI();
    });

    pyProcess.on('close', (code, signal) => {
        if (window.SubSplitLogger) {
            window.SubSplitLogger.info('PYTHON_EXIT', `Process exited with code ${code}, signal ${signal}`);
        }
        resetUI();

        if (code !== 0 && code !== null) {
            setStatus('Сбой', 'error');
            log(`Процесс завершился с кодом ${code}. Проверьте лог выше.`);
        }
    });
}

function onSuccess(srtPath) {
    const animEl = document.getElementById('animStyleSelect');
    const animStyle = animEl ? animEl.value : 'spring_pop';
    const accentCfgJson = JSON.stringify(getAccentConfig());

    if (window.SubSplitLogger) {
        window.SubSplitLogger.info('PROCESS_SUCCESS', `Single track generated: ${srtPath} (anim=${animStyle})`);
    }
    setProgress(100);
    setStatus('Готово!', 'ready');
    log(`✅ Файл сохранён: ${srtPath}`);

    if (csInterface) {
        const safePath = srtPath.replace(/\\/g, '/');
        const extPath = getCleanExtensionPath();
        if (animStyle && animStyle !== 'none') {
            log(`✨ Создание редактируемых Graphic-субтитров с Apple Smooth Animation (${animStyle}) на таймлайне...`);
        }
        csInterface.evalScript(`$.evalFile(${JSON.stringify(extPath + '/host/index.jsx')}); importSrtToProject(${JSON.stringify(safePath)}, ${JSON.stringify(animStyle)}, ${JSON.stringify(accentCfgJson)})`, (resStr) => {
            try {
                const res = JSON.parse(resStr);
                if (res.status === 'success') {
                    if (res.onTimeline) {
                        if (res.animated) {
                            const count = res.animatedCount || res.clipsCreated || 0;
                            log(`🎉 Создано ${count} редактируемых Graphic-субтитров (${res.animStyle}) на дорожке V${res.videoTrack || 2}!`);
                            setStatus(`Graphic V${res.videoTrack || 2}! ✨`, 'ready');
                            loadTimelineCuesForAccentEditor(false);
                        } else {
                            log('🎉 Субтитры автоматически добавлены прямо на таймлайн!');
                            setStatus('На таймлайне! 🚀', 'ready');
                        }
                    } else {
                        log('✅ Свежий файл субтитров добавлен в панель проекта (Bin).');
                        log('⚠️ Внимание: если на таймлайне уже лежит старая дорожка субтитров, Premiere не даёт скрипту перезаписать её. Удалите старую дорожку с таймлайна (Правый клик по заголовку дорожки -> Удалить дорожку) и перетащите файл из Bin.');
                        setStatus('В панели Bin', 'ready');
                        if (res.details) log(`ℹ️ ${res.details}`);
                    }
                } else if (res.error) {
                    log(`ℹ️ ${res.error}`);
                }
            } catch (e) {
                log('👉 Субтитры готовы в проекте.');
            }
        });
    }
}

function onSuccessDual(translateSrt, originalSrt) {
    const animEl = document.getElementById('animStyleSelect');
    const animStyle = animEl ? animEl.value : 'spring_pop';
    const accentCfgJson = JSON.stringify(getAccentConfig());

    if (window.SubSplitLogger) {
        window.SubSplitLogger.info('PROCESS_SUCCESS_DUAL', `Dual tracks generated: Translate=${translateSrt}, Original=${originalSrt} (anim=${animStyle})`);
    }
    setProgress(100);
    setStatus('Готово!', 'ready');
    log(`✅ Файл перевода: ${translateSrt}`);
    if (originalSrt) log(`✅ Файл оригинала: ${originalSrt}`);

    if (csInterface) {
        const safeTrans = translateSrt.replace(/\\/g, '/');
        const safeOrig = originalSrt ? originalSrt.replace(/\\/g, '/') : '';
        const extPath = getCleanExtensionPath();
        if (animStyle && animStyle !== 'none') {
            log(`✨ Создание 2 дорожек редактируемых Graphic-субтитров (${animStyle}) на таймлайне...`);
        }
        csInterface.evalScript(`$.evalFile(${JSON.stringify(extPath + '/host/index.jsx')}); importDualSrtToTimeline(${JSON.stringify(safeTrans)}, ${JSON.stringify(safeOrig)}, ${JSON.stringify(animStyle)}, ${JSON.stringify(accentCfgJson)})`, (resStr) => {
            try {
                const res = JSON.parse(resStr);
                if (res.status === 'success') {
                    if (res.trackTranslate && res.trackTranslate.animated) {
                        log(`🎉 2 дорожки редактируемых Graphic-субтитров (${animStyle}) размещены на V${res.trackTranslate.videoTrack || 2} и V${(res.trackOriginal && res.trackOriginal.videoTrack) || 3}!`);
                        setStatus(`Graphic V2+V3! ✨`, 'ready');
                        loadTimelineCuesForAccentEditor(false);
                    } else {
                        log('🎉 Две дорожки субтитров (Перевод и Оригинал) успешно добавлены на таймлайн Premiere Pro!');
                        setStatus('2 дорожки готовы! 🚀', 'ready');
                    }
                } else if (res.error) {
                    log(`⚠️ Предупреждение импорта дорожек: ${res.error}`);
                }
            } catch (e) {
                log('👉 Субтитры готовы в проекте.');
            }
        });
    }
}

// ==========================================================================
// Project Organizer Controller
// ==========================================================================

let activeProjectInfo = null;

function setupOrganizerListeners() {
    const btnRefreshProject = document.getElementById('btnRefreshProject');
    if (btnRefreshProject) {
        btnRefreshProject.addEventListener('click', refreshProjectInfo);
    }

    const btnAddProtected = document.getElementById('btnAddProtectedFolder');
    if (btnAddProtected) {
        btnAddProtected.addEventListener('click', onAddProtectedFolderClick);
    }

    const btnOrganize = document.getElementById('btnOrganizeProject');
    if (btnOrganize) {
        btnOrganize.addEventListener('click', onOrganizeClick);
    }
}

function refreshProjectInfo() {
    const pathEl = document.getElementById('projectDirPath');
    const indicatorEl = document.getElementById('projectIndicator');

    if (!pathEl) return;
    pathEl.textContent = 'Определение проекта...';

    if (!csInterface) {
        pathEl.textContent = 'Режим браузера (тест): ~/Projects/DemoProject';
        activeProjectInfo = {
            projectPath: '~/Projects/DemoProject/project.prproj',
            projectDir: '~/Projects/DemoProject'
        };
        if (indicatorEl) {
            indicatorEl.style.backgroundColor = 'var(--success)';
            indicatorEl.style.boxShadow = '0 0 6px rgba(16, 185, 129, 0.6)';
        }
        return;
    }

    if (indicatorEl) {
        indicatorEl.style.backgroundColor = 'var(--warning)';
        indicatorEl.style.boxShadow = '0 0 6px rgba(245, 158, 11, 0.6)';
    }

    csInterface.evalScript('getProjectRootInfo()', (resStr) => {
        try {
            const res = JSON.parse(resStr);
            if (res.error) {
                pathEl.textContent = res.error;
                activeProjectInfo = null;
                if (indicatorEl) {
                    indicatorEl.style.backgroundColor = 'var(--danger)';
                    indicatorEl.style.boxShadow = '0 0 6px rgba(239, 68, 68, 0.6)';
                }
            } else {
                activeProjectInfo = res;
                pathEl.textContent = res.projectDir;
                if (indicatorEl) {
                    indicatorEl.style.backgroundColor = 'var(--success)';
                    indicatorEl.style.boxShadow = '0 0 6px rgba(16, 185, 129, 0.6)';
                }
            }
        } catch (e) {
            pathEl.textContent = 'Ошибка связи с Premiere Pro';
            activeProjectInfo = null;
            if (indicatorEl) {
                indicatorEl.style.backgroundColor = 'var(--danger)';
                indicatorEl.style.boxShadow = '0 0 6px rgba(239, 68, 68, 0.6)';
            }
        }
    });
}

function renderProtectedFolders() {
    const container = document.getElementById('protectedFoldersList');
    const badge = document.getElementById('protectedCountBadge');
    if (!container || typeof Organizer === 'undefined') return;

    const folders = Organizer.getProtectedFolders();
    if (badge) {
        let suffix = 'папок';
        const n = folders.length;
        if (n % 10 === 1 && n % 100 !== 11) suffix = 'папка';
        else if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) suffix = 'папки';
        badge.textContent = `${n} ${suffix}`;
    }

    container.innerHTML = '';

    if (folders.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'folder-tag-empty';
        emptyEl.id = 'folderTagEmpty';
        emptyEl.textContent = 'Нет добавленных библиотек. Все внешние файлы будут перенесены в проект.';
        container.appendChild(emptyEl);
        return;
    }

    folders.forEach(folderPath => {
        const tag = document.createElement('div');
        tag.className = 'folder-tag';

        const pathSpan = document.createElement('span');
        pathSpan.className = 'folder-path';
        pathSpan.title = folderPath;
        pathSpan.textContent = folderPath;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-remove-tag';
        removeBtn.title = 'Удалить из исключений';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => {
            Organizer.removeProtectedFolder(folderPath);
            renderProtectedFolders();
            log(`🗑️ Папка исключена из защищенных библиотек: ${folderPath}`);
        });

        tag.appendChild(pathSpan);
        tag.appendChild(removeBtn);
        container.appendChild(tag);
    });
}

function onAddProtectedFolderClick() {
    if (!csInterface) {
        alert('Системный диалог доступен только внутри Premiere Pro.');
        return;
    }

    csInterface.evalScript('selectFolderDialog("Выберите постоянную папку-библиотеку (Только копирование)")', (resStr) => {
        try {
            const res = JSON.parse(resStr);
            if (res && res.status === 'success' && res.path) {
                const added = Organizer.addProtectedFolder(res.path);
                if (added) {
                    renderProtectedFolders();
                    log(`🛡️ Добавлена защищенная библиотека (только копирование):\n${res.path}`);
                }
            }
        } catch (e) {}
    });
}

async function onOrganizeClick() {
    if (!activeProjectInfo || !activeProjectInfo.projectDir) {
        alert('Пожалуйста, сохраните проект Premiere Pro на диске (Cmd+S) перед организацией.');
        refreshProjectInfo();
        return;
    }

    const doFootage = document.getElementById('catFootage').checked;
    const doAudio = document.getElementById('catAudio').checked;
    const doGraphics = document.getElementById('catGraphics').checked;
    const doSubtitles = document.getElementById('catSubtitles').checked;

    const enabledCategories = {
        footage: doFootage,
        audio: doAudio,
        graphics: doGraphics,
        subtitles: doSubtitles,
        sequences: true
    };

    const btnOrganize = document.getElementById('btnOrganizeProject');
    btnOrganize.disabled = true;
    setStatus('Сканирование...', 'busy');
    setProgress(10);
    log(`\n========================================`);
    log(`🧹 Запуск организации проекта...`);
    log(`📁 Целевая папка проекта: ${activeProjectInfo.projectDir}`);

    const protectedFolders = Organizer.getProtectedFolders();
    if (protectedFolders.length > 0) {
        log(`🛡️ Защищённые библиотеки (${protectedFolders.length}):\n${protectedFolders.join('\n')}`);
    } else {
        log(`ℹ️ Защищённых библиотек нет. Все внешние файлы будут перенесены (Move).`);
    }

    csInterface.evalScript('getProjectItemsManifest()', (manifestStr) => {
        try {
            const manifest = JSON.parse(manifestStr);
            if (manifest.error) {
                log(`❌ Ошибка сканирования проекта: ${manifest.error}`);
                setStatus('Ошибка', 'error');
                btnOrganize.disabled = false;
                hideProgress();
                return;
            }

            const items = manifest.items || [];
            log(`Найдено элементов в проекте: ${items.length}`);

            const plan = {
                bins: [
                    Organizer.BINS_MAP.sequences,
                    Organizer.BINS_MAP.footage,
                    Organizer.BINS_MAP.audio,
                    Organizer.BINS_MAP.graphics,
                    Organizer.BINS_MAP.subtitles
                ],
                actions: []
            };

            let movedFilesCount = 0;
            let copiedFilesCount = 0;
            let alreadyOrganizedCount = 0;
            let skippedCategoryCount = 0;

            const pathModule = typeof require !== 'undefined' ? require('path') : null;
            const fsModule = typeof require !== 'undefined' ? require('fs') : null;

            setProgress(30);

            for (const item of items) {
                const classification = Organizer.classifyItem(item);

                // Если категория отключена пользователем
                if (!enabledCategories[classification.category]) {
                    skippedCategoryCount++;
                    continue;
                }

                // Для секвенций нет файла на диске, только бин
                if (item.isSequence) {
                    plan.actions.push({
                        nodeId: item.nodeId,
                        targetBin: classification.binName,
                        parentBinName: item.parentBinName
                    });
                    continue;
                }

                // Синтетический слой без физического файла
                if (!item.mediaPath) {
                    plan.actions.push({
                        nodeId: item.nodeId,
                        targetBin: classification.binName,
                        parentBinName: item.parentBinName
                    });
                    continue;
                }

                // Проверяем физический файл
                const srcPath = item.mediaPath;
                if (fsModule && !fsModule.existsSync(srcPath)) {
                    log(`⚠️ Файл не найден на диске (Offline): ${item.name}`);
                    plan.actions.push({
                        nodeId: item.nodeId,
                        targetBin: classification.binName,
                        parentBinName: item.parentBinName
                    });
                    continue;
                }

                const targetFolder = pathModule ? pathModule.join(activeProjectInfo.projectDir, classification.binName) : '';

                // 1. Файл уже лежит в правильной целевой подпапке проекта
                if (Organizer.isSubpath(srcPath, targetFolder)) {
                    alreadyOrganizedCount++;
                    plan.actions.push({
                        nodeId: item.nodeId,
                        targetBin: classification.binName,
                        parentBinName: item.parentBinName
                    });
                    continue;
                }

                // 2. Проверяем, находится ли файл в списке защищенных папок (Только копирование)
                const isProtected = protectedFolders.some(prof => Organizer.isSubpath(srcPath, prof));

                const fileName = pathModule ? pathModule.basename(srcPath) : item.name;
                const uniqueDst = Organizer.getUniqueDestinationPath(targetFolder, fileName);

                if (isProtected) {
                    // КОПИРУЕМ
                    try {
                        Organizer.copyFileSafe(srcPath, uniqueDst);
                        copiedFilesCount++;
                        const finalBaseName = pathModule ? pathModule.basename(uniqueDst) : fileName;
                        log(`📋 Скопировано (библиотека): ${item.name} ➔ ${classification.binName}/${finalBaseName}`);
                        plan.actions.push({
                            nodeId: item.nodeId,
                            targetBin: classification.binName,
                            newMediaPath: uniqueDst,
                            parentBinName: item.parentBinName
                        });
                    } catch (errCopy) {
                        log(`❌ Ошибка копирования ${item.name}: ${errCopy.message}`);
                    }
                } else {
                    // ПЕРЕНОСИМ (Move)
                    try {
                        Organizer.moveFileSafe(srcPath, uniqueDst);
                        movedFilesCount++;
                        const finalBaseName = pathModule ? pathModule.basename(uniqueDst) : fileName;
                        log(`🚚 Перенесено в проект: ${item.name} ➔ ${classification.binName}/${finalBaseName}`);
                        plan.actions.push({
                            nodeId: item.nodeId,
                            targetBin: classification.binName,
                            newMediaPath: uniqueDst,
                            parentBinName: item.parentBinName
                        });
                    } catch (errMove) {
                        log(`❌ Ошибка переноса ${item.name}: ${errMove.message}`);
                    }
                }
            }

            setProgress(70);
            setStatus('Обновление Premiere...', 'busy');

            // Отправляем план в Premiere Pro ExtendScript
            const planJsonStr = JSON.stringify(plan);
            csInterface.evalScript(`applyProjectOrganization(${JSON.stringify(planJsonStr)})`, (applyResStr) => {
                btnOrganize.disabled = false;
                try {
                    const applyRes = JSON.parse(applyResStr);
                    if (applyRes.error) {
                        log(`❌ Ошибка применения бинов: ${applyRes.error}`);
                        setStatus('Ошибка бинов', 'error');
                        hideProgress();
                    } else {
                        setProgress(100);
                        setStatus('Порядок наведён! 🎉', 'ready');
                        log(`\n🎉 НАВЕДЕНИЕ ПОРЯДКА ЗАВЕРШЕНО УСПЕШНО!`);
                        log(`🚚 Перенесено на диск: ${movedFilesCount}`);
                        log(`📋 Скопировано из библиотек: ${copiedFilesCount}`);
                        log(`📁 Разобрано по бинам Premiere: ${applyRes.movedCount || plan.actions.length}`);
                        if (applyRes.relinkedCount) {
                            log(`🔗 Перелинковано путей: ${applyRes.relinkedCount}`);
                        }
                        if (applyRes.errors && applyRes.errors.length > 0) {
                            log(`⚠️ Предупреждения: ${applyRes.errors.join('; ')}`);
                        }
                    }
                } catch (eApply) {
                    btnOrganize.disabled = false;
                    hideProgress();
                    log(`Ошибка ответа ExtendScript: ${eApply}`);
                }
            });

        } catch (eManifest) {
            btnOrganize.disabled = false;
            hideProgress();
            log(`Ошибка обработки манифеста: ${eManifest.message}`);
            setStatus('Ошибка', 'error');
        }
    });
}

