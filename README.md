# SubSplit AI — Панель субтитров для Adobe Premiere Pro 🎬✨

[![Platform](https://img.shields.io/badge/Platform-Adobe%20Premiere%20Pro%202020--2026-blue.svg)](https://www.adobe.com/products/premiere.html)
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20(Metal)-success.svg)](#)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-blue.svg)](#)
[![Python](https://img.shields.io/badge/Python-3.10%20%7C%203.11%20%7C%203.12-yellow.svg)](#)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](#)

**SubSplit AI** — это профессиональное расширение (CEP Panel) для **Adobe Premiere Pro**, создающее динамические виральные субтитры для **Reels, TikTok, YouTube Shorts и подкастов** с соблюдением правил русской типографики, нативными плавными анимациями Apple Motion и полностью локальным ИИ.

---

## 🌟 Ключевые возможности

* **Нативные редактируемые титры Premiere Pro (`Graphic` / `AE.ADBE Text`)**:
  * Никаких запеченных `.mov` видеофайлов!
  * Каждый титр — это полноценный текстовый клип Premiere Pro.
  * Шрифт, размер, кернинг, цвет заливки, обводка, тени и анимация остаются **на 100% редактируемыми** в панелях *Элементы управления эффектами (Effect Controls)* и *Основные графические элементы (Essential Graphics)*.
* **Apple Motion Smooth Animations**:
  * Физические плавные пружинные анимации ключевыми кадрами Безье (Bézier Smooth Easing).
  * 6 стилей анимации: **Apple Smooth Scale**, **Pop-Up**, **Bounce**, **Word Fade**, **Smooth Glaze**, **Glow Highlighter**.
* **Умные акцентные слова (Viral Accents)**:
  * Автоматическое выделение ключевых смысловых слов фразы.
  * Интерактивный кликабельный редактор слов на таймлайне.
  * Настраиваемый акцентный цвет (фирменный желтый `#FFD700`, неоновый зеленый, cyan, коралл), масштаб (до 180%), капитализация (CAPS) и размещение на отдельной строке.
* **Слайдеры количества слов и строк**:
  * **Слайдер слов (1–10)**: гибкий контроль темпа субтитров.
  * **Слайдер строк (1–3)**:
    * *1 строка*: субтитры строго удерживаются в одну линию (акцентные слова не разбивают строку).
    * *2 и 3 строки*: интеллектуальный алгоритм динамического программирования балансирует текст по строкам, предотвращая висячие предлоги (`в`, `на`, `от`, `с`, `из`, `до`, `по`, `что`, `как` и др.).
* **Ультра-быстрая локальная транскрибация**:
  * **Apple Silicon Metal GPU** (`mlx-whisper` float16) — аппаратное ускорение на чипах M1/M2/M3/M4 со скоростью до 15x быстрее реального времени!
  * **Faster-Whisper (CPU / NVIDIA CUDA)** в качестве универсального резервного движка.
  * Умная группировка склеек таймлайна (`.cuts.json`) и акустических речевых островов — тишина пропускается, вызовы нейросети сокращаются в 4–5 раз.
* **Многоязычность и перевод**:
  * Мгновенная адаптивная детекция языка (RU vs EN) на речевых сегментах.
  * Поддержка контекстного перевода реплик через локальный сервер **Ollama** с пропорциональной синхронизацией таймингов слов.
* **Встроенный 1-клик автоапдейтер (In-App Auto-Updater)**:
  * Плагин автоматически проверяет обновления на GitHub при запуске (или по клику на бейдж `v1.0.0`).
  * При выходе новой версии в шапке панели загорается янтарный бейдж `✨ v1.x.x` и всплывает плашка с описанием обновлений.
  * Нажатие кнопки **«Обновить»** подтягивает изменения через `git pull` (или ZIP), обновляет зависимости Python и мгновенно перезагружает интерфейс — **перезапускать Premiere Pro не требуется!**
* **Организатор проекта (Project Bin Organizer)**:
  * Автоматическое распределение исходников по структурированным корзинам (`01_FOOTAGE`, `02_AUDIO`, `03_GRAPHICS`, `04_SUBTITLES`, `99_SEQUENCES`).

---

## 🚀 Быстрая установка

### macOS (Рекомендуется)

1. Откройте терминал и выполните команду:
   ```bash
   git clone https://github.com/kberenzev-maker/subsplit-ai.git
   cd subsplit-ai
   ./install.sh
   ```

2. Скрипт установки автоматически:
   - Включит режим разработчика Adobe CEP (`PlayerDebugMode = 1`) для Premiere Pro 2020–2026.
   - Подключит плагин в `~/Library/Application Support/Adobe/CEP/extensions/`.
   - Проверит наличие `python3` (3.10+) и `ffmpeg`.
   - Создаст изолированное виртуальное окружение `backend/venv` со всеми зависимостями.
   - **Предварительно скачает и протестирует модель Whisper Turbo** (Apple Metal GPU / CPU), чтобы первый запуск в Premiere Pro произошел мгновенно без пауз на скачивание весов!

#### Дополнительные опции установщика:
```bash
./install.sh --all-models   # Скачать все модели (turbo, small, medium, base)
./install.sh --no-models    # Пропустить скачивание моделей при установке
./install.sh --copy         # Скопировать файлы вместо создания симлинка
```

---

### Windows

1. Убедитесь, что установлен [Python 3.10–3.12](https://www.python.org/downloads/) (обязательно отметьте галочку **"Add python.exe to PATH"** при установке).
2. Склонируйте репозиторий и запустите установщик:
   ```cmd
   git clone https://github.com/kberenzev-maker/subsplit-ai.git
   cd subsplit-ai
   install.bat
   ```

---

## 🎮 Как пользоваться в Adobe Premiere Pro

1. Запустите или перезапустите **Adobe Premiere Pro**.
2. Откройте проект и перейдите в нужную секвенцию на таймлайне.
3. В верхнем меню выберите:  
   **Окно (Window)** $\rightarrow$ **Расширения (Extensions)** $\rightarrow$ **SubSplit AI Subtitles**.
4. Настройте желаемый формат:
   - Количество слов в чанке (ползунок **1–10**).
   - Количество строк субтитров (**1**, **2** или **3** строки).
   - Стиль анимации Apple Motion (Scale, Pop-Up, Bounce, Word Fade и др.).
   - Параметры акцентных слов (масштаб, цвет, прописные буквы).
5. Нажмите большую кнопку **🚀 Создать субтитры**.
6. Плагин извлечет звук, распознает речь с посекундными таймингами, сбалансирует строки и разместит редактируемые `Graphic`-клипы субтитров прямо на таймлайне!

---

## 🧠 Управление моделями нейросети

SubSplit AI поставляется с утилитой предварительного кэширования моделей Whisper:

```bash
# Проверить список поддерживаемых моделей
./backend/venv/bin/python backend/download_models.py --list

# Предварительно загрузить конкретную модель:
./backend/venv/bin/python backend/download_models.py --model turbo    # По умолчанию (~1.6 ГБ, Metal GPU + CPU)
./backend/venv/bin/python backend/download_models.py --model small    # Легкая модель (~460 МБ)
./backend/venv/bin/python backend/download_models.py --model medium   # Сбалансированная (~1.5 ГБ)
./backend/venv/bin/python backend/download_models.py --model all      # Все доступные модели
```

---

## 🛠 Архитектура проекта

```text
subsplit-ai/
├── CSXS/
│   └── manifest.xml          # Манифест расширения Adobe CEP (HostList: PPRO 14.0–26.9)
├── assets/
│   └── mogrts/               # Motion Graphics Templates для титров
├── client/
│   ├── index.html            # Интерфейс панели (Apple HIG / Dark UI)
│   ├── style.css             # Стили ползунков, чипсов, аккордеонов и адаптивных карточек
│   ├── app.js                # Клиентский контроллер (Node.js CEP runtime, запуск Python)
│   ├── logger.js             # Локальная система журналирования с экспортом
│   ├── organizer.js          # Логика автоматической сортировки корзин проекта
│   └── CSInterface.js        # Adobe CEP JavaScript SDK
├── host/
│   └── index.jsx             # ExtendScript: прямое управление таймлайном Premiere Pro,
│                             # генерация Graphic Text клипов и кривых Безье
├── backend/
│   ├── transcribe.py         # Whisper транскрибация (Apple Metal GPU / Faster-Whisper CPU)
│   ├── chunker.py            # Алгоритм нарезки фраз и балансировки строк без висячих предлогов
│   ├── proofread.py          # Автоматическая вычитка регистра, пунктуации и опечаток
│   ├── translator.py         # Многоязычный перевод и интерполяция таймингов
│   ├── srt_parser.py         # Парсер и генератор формата субтитров SRT
│   ├── download_models.py    # Менеджер предварительной загрузки и верификации моделей
│   ├── requirements.txt      # Зависимости Python
│   └── main.py               # Главный CLI контроллер бэкенда
├── install.sh                # Автоматический установщик для macOS / Linux
├── install.bat               # Автоматический установщик для Windows
└── README.md                 # Документация проекта
```

---

## 💡 Требования к системе

* **macOS** 12.0+ (поддерживаются Apple Silicon M1/M2/M3/M4 и Intel) или **Windows 10/11 (64-bit)**.
* **Adobe Premiere Pro**: версии 2020, 2021, 2022, 2023, 2024, 2025, 2026.
* **Python**: 3.10, 3.11 или 3.12.
* **FFmpeg**: рекомендуется для прямого извлечения аудио дорожек (`brew install ffmpeg` на macOS или `winget install Gyan.FFmpeg` на Windows).

---

## 📄 Лицензия

MIT License. Свободно для личного и коммерческого использования при монтаже видео.
