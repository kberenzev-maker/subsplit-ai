/**
 * SubSplit Studio - Black-Box Logger
 * Записывает абсолютно все события плагина в постоянный файл на диске:
 * - Все клики пользователя, переключения тумблеров и селектов
 * - Все вызовы ExtendScript (Premiere Pro API) и их ответы/ошибки с миллисекундами
 * - Полные команды запуска Python, аргументы CLI, переменные среды
 * - Все строки stdout и stderr до единого байта
 * - Системные ошибки, unhandled rejections и сбои
 * 
 * Путь к лог-файлу: ~/Library/Logs/SubSplit/subsplit.log
 */

(function (window) {
    'use strict';

    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const { exec } = require('child_process');

    const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'SubSplit');
    const LOG_FILE = path.join(LOG_DIR, 'subsplit.log');
    const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB

    // Инициализация директории логов
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        // Ротация логов при превышении 10 МБ
        if (fs.existsSync(LOG_FILE)) {
            const stats = fs.statSync(LOG_FILE);
            if (stats.size > MAX_LOG_SIZE) {
                const prevLog = path.join(LOG_DIR, 'subsplit.prev.log');
                if (fs.existsSync(prevLog)) fs.unlinkSync(prevLog);
                fs.renameSync(LOG_FILE, prevLog);
            }
        }
    } catch (e) {
        console.error('Не удалось инициализировать директорию логов:', e);
    }

    function getTimestamp() {
        const now = new Date();
        const pad = (n, len = 2) => String(n).padStart(len, '0');
        const y = now.getFullYear();
        const m = pad(now.getMonth() + 1);
        const d = pad(now.getDate());
        const h = pad(now.getHours());
        const min = pad(now.getMinutes());
        const s = pad(now.getSeconds());
        const ms = pad(now.getMilliseconds(), 3);
        return `${y}-${m}-${d} ${h}:${min}:${s}.${ms}`;
    }

    function writeRaw(line) {
        try {
            fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
        } catch (err) {
            console.error('Ошибка записи в лог:', err);
        }
    }

    const Logger = {
        getLogPath() {
            return LOG_FILE;
        },

        getLogDir() {
            return LOG_DIR;
        },

        log(level, tag, message, data = null) {
            const ts = getTimestamp();
            let payload = '';
            if (data !== null && data !== undefined) {
                if (typeof data === 'object') {
                    try {
                        payload = ' ' + JSON.stringify(data);
                    } catch (e) {
                        payload = ' [Unserializable Object]';
                    }
                } else {
                    payload = ' ' + String(data);
                }
            }
            const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${tag}] ${message}${payload}`;
            writeRaw(line);
        },

        info(tag, message, data) {
            this.log('INFO', tag, message, data);
        },

        warn(tag, message, data) {
            this.log('WARN', tag, message, data);
        },

        error(tag, message, data) {
            this.log('ERROR', tag, message, data);
        },

        debug(tag, message, data) {
            this.log('DEBUG', tag, message, data);
        },

        action(tag, message, data) {
            this.log('ACTION', tag, message, data);
        },

        openLogFile() {
            try {
                if (!fs.existsSync(LOG_FILE)) {
                    writeRaw(`[${getTimestamp()}] [INFO] [INIT] Лог-файл создан.`);
                }
                exec(`open "${LOG_FILE}"`);
            } catch (e) {
                alert(`Лог-файл находится по адресу: ${LOG_FILE}`);
            }
        },

        openLogFolder() {
            try {
                exec(`open "${LOG_DIR}"`);
            } catch (e) {
                alert(`Папка с логами: ${LOG_DIR}`);
            }
        }
    };

    // Запись стартовой метки новой сессии
    writeRaw(`\n==================== [SESSION START: ${getTimestamp()}] ====================`);
    writeRaw(`OS: ${os.type()} ${os.release()} (${os.arch()}), Host: ${os.hostname()}, User: ${os.userInfo().username}`);
    writeRaw(`Node.js: ${process.version}, CEP Extension Path: ${__dirname}\n`);

    // Глобальный перехват необработанных исключений
    window.addEventListener('error', (event) => {
        Logger.error('UNCAUGHT_EXCEPTION', event.message, {
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: event.error ? event.error.stack : null
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        Logger.error('PROMISE_REJECTION', event.reason ? (event.reason.stack || String(event.reason)) : 'Unknown rejection');
    });

    // Автоматическое логирование всех кликов и изменений элементов интерфейса
    document.addEventListener('click', (e) => {
        try {
            const target = e.target.closest('button, input, select, a, [role="button"], .tab-btn, .option-pill');
            if (target) {
                const id = target.id ? `#${target.id}` : '';
                const cls = target.className && typeof target.className === 'string'
                    ? `.${target.className.trim().split(/\s+/).join('.')}`
                    : '';
                const text = (target.textContent || target.value || target.title || '').trim().replace(/\s+/g, ' ').slice(0, 60);
                const role = target.getAttribute('role') || target.tagName.toLowerCase();
                Logger.action('UI_CLICK', `${role}${id}${cls} (text: "${text}")`);
            }
        } catch (err) {}
    }, true);

    document.addEventListener('change', (e) => {
        try {
            const target = e.target;
            if (target && target.matches('input, select, textarea')) {
                const id = target.id ? `#${target.id}` : (target.name ? `[name="${target.name}"]` : target.tagName.toLowerCase());
                let val = target.value;
                if (target.type === 'checkbox') {
                    val = target.checked ? 'CHECKED' : 'UNCHECKED';
                }
                Logger.action('UI_CHANGE', `${id} => ${val}`);
            }
        } catch (err) {}
    }, true);

    window.SubSplitLogger = Logger;

})(window);
