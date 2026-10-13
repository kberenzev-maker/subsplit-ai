/**
 * SubSplit AI - In-App GitHub Auto-Updater
 * Checks for updates from GitHub (version.json or git commits),
 * provides 1-click update via git pull or release archive,
 * and reloads the panel without restarting Adobe Premiere Pro.
 */

(function (window) {
    'use strict';

    const GITHUB_OWNER = 'kberenzev-maker';
    const GITHUB_REPO = 'subsplit-ai';
    const GITHUB_BRANCH = 'main';
    const REMOTE_VERSION_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/version.json`;

    class SubSplitUpdater {
        constructor() {
            this.localVersion = { version: '1.0.0', build: 1 };
            this.remoteVersion = null;
            this.isChecking = false;
            this.isUpdating = false;
            this.extDir = '';
            this.pythonBin = '';
            this.hasGit = false;
        }

        init(backendInfo) {
            if (backendInfo) {
                this.extDir = backendInfo.extDir || '';
                this.pythonBin = backendInfo.pythonBin || '';
            }

            this.loadLocalVersion();
            this.detectGit();
            this.bindUI();

            // Автоматическая проверка через 3 секунды после старта (не чаще 1 раза в 30 минут)
            setTimeout(() => {
                const lastCheck = parseInt(localStorage.getItem('subsplit_last_update_check') || '0', 10);
                const now = Date.now();
                if (now - lastCheck > 30 * 60 * 1000) {
                    this.checkForUpdates(false);
                }
            }, 3000);
        }

        detectGit() {
            try {
                const fs = require('fs');
                const path = require('path');
                if (this.extDir && fs.existsSync(path.join(this.extDir, '.git'))) {
                    this.hasGit = true;
                }
            } catch (e) {
                this.hasGit = false;
            }
        }

        loadLocalVersion() {
            try {
                const fs = require('fs');
                const path = require('path');
                let vPath = '';
                if (this.extDir) {
                    vPath = path.join(this.extDir, 'version.json');
                } else if (typeof __dirname !== 'undefined') {
                    vPath = path.resolve(__dirname, '..', 'version.json');
                }

                if (vPath && fs.existsSync(vPath)) {
                    const raw = fs.readFileSync(vPath, 'utf8');
                    this.localVersion = JSON.parse(raw);
                }
            } catch (err) {
                console.warn('[Updater] Не удалось прочитать локальный version.json:', err);
            }

            const verTextEl = document.getElementById('versionText');
            if (verTextEl && this.localVersion.version) {
                verTextEl.textContent = `v${this.localVersion.version}`;
            }
        }

        compareVersions(v1, v2) {
            // Возвращает 1 если v2 > v1, -1 если v1 > v2, 0 если равны
            const parse = (v) => (v || '0').replace(/^v/, '').split('.').map(x => parseInt(x, 10) || 0);
            const a = parse(v1);
            const b = parse(v2);
            for (let i = 0; i < Math.max(a.length, b.length); i++) {
                const valA = a[i] || 0;
                const valB = b[i] || 0;
                if (valB > valA) return 1;
                if (valA > valB) return -1;
            }
            return 0;
        }

        async checkForUpdates(manual = false) {
            if (this.isChecking || this.isUpdating) return;
            this.isChecking = true;

            const badge = document.getElementById('versionBadge');
            const dot = badge ? badge.querySelector('.version-dot') : null;
            const verTextEl = document.getElementById('versionText');

            if (manual && verTextEl) {
                verTextEl.textContent = 'Проверка...';
            }

            try {
                const remote = await this.fetchRemoteVersion();
                this.remoteVersion = remote;
                localStorage.setItem('subsplit_last_update_check', Date.now().toString());

                const isNewer = this.compareVersions(this.localVersion.version, remote.version) === 1 ||
                    (remote.build && this.localVersion.build && remote.build > this.localVersion.build);

                if (isNewer) {
                    this.showUpdateAvailable(remote);
                } else {
                    if (verTextEl) verTextEl.textContent = `v${this.localVersion.version}`;
                    if (dot) {
                        dot.className = 'version-dot active';
                    }
                    if (manual) {
                        this.showNotification('У вас установлена самая свежая версия!', 'success');
                    }
                }
            } catch (err) {
                console.warn('[Updater] Ошибка проверки обновлений:', err);
                if (verTextEl) verTextEl.textContent = `v${this.localVersion.version}`;
                if (manual) {
                    this.showNotification('Не удалось связаться с GitHub (нет сети)', 'warning');
                }
            } finally {
                this.isChecking = false;
            }
        }

        fetchRemoteVersion() {
            return new Promise((resolve, reject) => {
                try {
                    const https = require('https');
                    const url = `${REMOTE_VERSION_URL}?_t=${Date.now()}`;
                    const req = https.get(url, { headers: { 'User-Agent': 'SubSplit-CEP-App' } }, (res) => {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            return reject(new Error(`HTTP ${res.statusCode}`));
                        }
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });
                    req.on('error', reject);
                    req.setTimeout(6000, () => {
                        req.abort();
                        reject(new Error('Timeout'));
                    });
                } catch (e) {
                    reject(e);
                }
            });
        }

        showUpdateAvailable(remote) {
            const badge = document.getElementById('versionBadge');
            const dot = badge ? badge.querySelector('.version-dot') : null;
            const verTextEl = document.getElementById('versionText');

            if (badge) {
                badge.classList.add('has-update');
                badge.title = `Доступно обновление v${remote.version}. Нажмите для обновления.`;
            }
            if (dot) {
                dot.className = 'version-dot update';
            }
            if (verTextEl) {
                verTextEl.textContent = `✨ v${remote.version}`;
            }

            // Показываем красивый баннер
            const banner = document.getElementById('updateBanner');
            const newVerEl = document.getElementById('updateNewVersion');
            const notesEl = document.getElementById('updateReleaseNotes');

            if (banner && newVerEl) {
                newVerEl.textContent = `v${remote.version}`;
                if (notesEl && remote.description) {
                    notesEl.textContent = remote.description;
                }
                banner.style.display = 'block';
                banner.classList.add('fadeInUpdate');
            }
        }

        async applyUpdate() {
            if (this.isUpdating) return;
            this.isUpdating = true;

            const btnApply = document.getElementById('btnApplyUpdate');
            const pBar = document.getElementById('updateProgressBar');
            const pFill = document.getElementById('updateProgressFill');
            const statusMsg = document.getElementById('updateStatusMsg');

            if (btnApply) {
                btnApply.disabled = true;
                btnApply.textContent = 'Обновление...';
            }
            if (pBar) pBar.style.display = 'block';
            if (statusMsg) {
                statusMsg.style.display = 'block';
                statusMsg.textContent = 'Загрузка обновлений с GitHub...';
            }
            if (pFill) pFill.style.width = '30%';

            try {
                if (this.hasGit) {
                    await this.updateViaGit(statusMsg, pFill);
                } else {
                    await this.updateViaZip(statusMsg, pFill);
                }

                if (pFill) pFill.style.width = '100%';
                if (statusMsg) statusMsg.textContent = 'Обновление завершено! Перезагрузка...';

                setTimeout(() => {
                    window.location.reload();
                }, 1200);
            } catch (err) {
                console.error('[Updater] Ошибка применения обновления:', err);
                if (statusMsg) {
                    statusMsg.textContent = `Ошибка: ${err.message || 'Не удалось обновить'}`;
                    statusMsg.style.color = '#ef4444';
                }
                if (btnApply) {
                    btnApply.disabled = false;
                    btnApply.textContent = 'Повторить';
                }
                this.isUpdating = false;
            }
        }

        updateViaGit(statusMsg, pFill) {
            return new Promise((resolve, reject) => {
                const { exec } = require('child_process');
                const path = require('path');

                if (statusMsg) statusMsg.textContent = 'Выполнение git pull origin main...';
                if (pFill) pFill.style.width = '50%';

                exec('git pull origin main', { cwd: this.extDir }, (err, stdout, stderr) => {
                    if (err) {
                        return reject(new Error(`Git pull failed: ${stderr || err.message}`));
                    }

                    if (pFill) pFill.style.width = '80%';
                    if (statusMsg) statusMsg.textContent = 'Проверка Python зависимостей...';

                    // Проверяем, нужно ли обновить pip зависимости
                    const pipBin = this.pythonBin ? this.pythonBin.replace(/python(\.exe)?$/, 'pip$1') : '';
                    const reqFile = path.join(this.extDir, 'backend', 'requirements.txt');

                    if (pipBin && require('fs').existsSync(pipBin) && require('fs').existsSync(reqFile)) {
                        exec(`"${pipBin}" install -r "${reqFile}" --quiet`, { cwd: this.extDir }, () => {
                            resolve(true);
                        });
                    } else {
                        resolve(true);
                    }
                });
            });
        }

        updateViaZip(statusMsg, pFill) {
            return new Promise((resolve, reject) => {
                // Скачивание архива репозитория
                const https = require('https');
                const fs = require('fs');
                const path = require('path');
                const os = require('os');
                const { exec } = require('child_process');

                const zipUrl = `https://codeload.github.com/${GITHUB_OWNER}/${GITHUB_REPO}/zip/refs/heads/${GITHUB_BRANCH}`;
                const tmpZip = path.join(os.tmpdir(), `subsplit-update-${Date.now()}.zip`);
                const file = fs.createWriteStream(tmpZip);

                if (statusMsg) statusMsg.textContent = 'Скачивание ZIP архива...';
                if (pFill) pFill.style.width = '45%';

                https.get(zipUrl, (res) => {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
                    }
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close(() => {
                            if (statusMsg) statusMsg.textContent = 'Распаковка файлов обновления...';
                            if (pFill) pFill.style.width = '75%';

                            // Распаковываем с сохранением venv
                            const unzipCmd = process.platform === 'win32'
                                ? `tar -xf "${tmpZip}" -C "${this.extDir}" --strip-components=1`
                                : `tar -xzf "${tmpZip}" -C "${this.extDir}" --strip-components=1`;

                            exec(unzipCmd, (unzipErr) => {
                                try { fs.unlinkSync(tmpZip); } catch (e) {}
                                if (unzipErr) {
                                    return reject(new Error(`Unzip failed: ${unzipErr.message}`));
                                }
                                resolve(true);
                            });
                        });
                    });
                }).on('error', (e) => {
                    try { fs.unlinkSync(tmpZip); } catch (err2) {}
                    reject(e);
                });
            });
        }

        showNotification(text, type = 'info') {
            const existing = document.getElementById('subsplitUpdateToast');
            if (existing) existing.remove();

            const toast = document.createElement('div');
            toast.id = 'subsplitUpdateToast';
            toast.className = `update-toast toast-${type}`;
            toast.textContent = text;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('show');
            }, 10);

            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 400);
            }, 3000);
        }

        bindUI() {
            const badge = document.getElementById('versionBadge');
            if (badge) {
                badge.addEventListener('click', () => {
                    this.checkForUpdates(true);
                });
            }

            const btnApply = document.getElementById('btnApplyUpdate');
            if (btnApply) {
                btnApply.addEventListener('click', () => {
                    this.applyUpdate();
                });
            }

            const btnDismiss = document.getElementById('btnDismissUpdate');
            if (btnDismiss) {
                btnDismiss.addEventListener('click', () => {
                    const banner = document.getElementById('updateBanner');
                    if (banner) banner.style.display = 'none';
                });
            }
        }
    }

    window.SubSplitUpdater = new SubSplitUpdater();
})(window);
