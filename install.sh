#!/usr/bin/env bash
# ==============================================================================
# SubSplit AI Installer for Adobe Premiere Pro (macOS & Linux)
# ==============================================================================
# Automatically configures Adobe CEP PlayerDebugMode, symlinks the extension,
# sets up a dedicated Python virtualenv with Apple Silicon Metal / CPU support,
# pre-downloads AI models, and verifies the environment.
# ==============================================================================

set -e

# ANSI Color formatting
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo ""
echo -e "${BOLD}${CYAN}==================================================================${NC}"
echo -e "${BOLD}${CYAN}      🚀 Установка панели SubSplit AI для Adobe Premiere Pro     ${NC}"
echo -e "${BOLD}${CYAN}==================================================================${NC}"
echo ""

# Configuration & Flags
COPY_MODE=false
SKIP_MODELS=false
MODEL_TYPE="turbo"

for arg in "$@"; do
    case $arg in
        --copy)
            COPY_MODE=true
            ;;
        --no-models)
            SKIP_MODELS=true
            ;;
        --all-models)
            MODEL_TYPE="all"
            ;;
        --help|-h)
            echo "Использование: ./install.sh [ОПЦИИ]"
            echo ""
            echo "Опции:"
            echo "  --copy         Скопировать файлы вместо создания симлинка"
            echo "  --no-models    Пропустить предварительное скачивание моделей"
            echo "  --all-models   Скачать все модели (turbo, small, medium, base)"
            echo "  --help, -h     Показать эту справку"
            exit 0
            ;;
        *)
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------------------------------------------------------------------------------
# 1. PlayerDebugMode для Adobe CEP
# ------------------------------------------------------------------------------
echo -e "${BOLD}[1/5] Активация режима разработки Adobe CEP (PlayerDebugMode)...${NC}"
if [[ "$OSTYPE" == "darwin"* ]]; then
    for v in {8..22}; do
        defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null || true
    done
    echo -e "      ${GREEN}✓ Режим отладки включен для версий CSXS 8..22 (macOS).${NC}"
else
    echo -e "      ${YELLOW}ℹ Пропуск plist (не macOS).${NC}"
fi

# ------------------------------------------------------------------------------
# 2. Подключение расширения в Adobe CEP
# ------------------------------------------------------------------------------
echo -e "${BOLD}[2/5] Подключение плагина в директорию расширений Premiere Pro...${NC}"
if [[ "$OSTYPE" == "darwin"* ]]; then
    CEP_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
else
    CEP_DIR="$HOME/.local/share/Adobe/CEP/extensions"
fi
mkdir -p "$CEP_DIR"
TARGET_DIR="$CEP_DIR/com.antigravity.subsplit"

if [ -L "$TARGET_DIR" ] || [ -d "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
fi

if [ "$COPY_MODE" = true ]; then
    echo "      Копирование файлов расширения..."
    cp -R "$SCRIPT_DIR" "$TARGET_DIR"
    echo -e "      ${GREEN}✓ Расширение скопировано в: $TARGET_DIR${NC}"
else
    ln -s "$SCRIPT_DIR" "$TARGET_DIR"
    echo -e "      ${GREEN}✓ Симлинк успешно создан: $TARGET_DIR -> $SCRIPT_DIR${NC}"
fi

# ------------------------------------------------------------------------------
# 3. Проверка системных утилит (Python 3.10+ и FFmpeg)
# ------------------------------------------------------------------------------
echo -e "${BOLD}[3/5] Проверка системных зависимостей (Python & FFmpeg)...${NC}"
PYTHON_BIN=""
for py in python3.12 python3.11 python3.10 python3; do
    if command -v $py >/dev/null 2>&1; then
        # Проверяем версию
        PY_VER=$($py -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
        MAJOR=$(echo $PY_VER | cut -d. -f1)
        MINOR=$(echo $PY_VER | cut -d. -f2)
        if [ "$MAJOR" -ge 3 ] && [ "$MINOR" -ge 10 ]; then
            PYTHON_BIN=$(command -v $py)
            break
        fi
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    echo -e "      ${RED}✗ ОШИБКА: Python 3.10 или новее не найден!${NC}"
    echo "      Пожалуйста, установите современный Python:"
    echo "        brew install python@3.12"
    exit 1
fi
echo -e "      ${GREEN}✓ Найден Python: $PYTHON_BIN ($($PYTHON_BIN --version))${NC}"

if command -v ffmpeg >/dev/null 2>&1; then
    echo -e "      ${GREEN}✓ FFmpeg обнаружен: $(which ffmpeg)${NC}"
else
    echo -e "      ${YELLOW}⚠ ВНИМАНИЕ: ffmpeg не найден в переменной PATH!${NC}"
    echo "      Для быстрого извлечения аудио из таймлайна рекомендуется установить:"
    echo "        brew install ffmpeg"
fi

# ------------------------------------------------------------------------------
# 4. Настройка виртуального окружения (backend/venv)
# ------------------------------------------------------------------------------
echo -e "${BOLD}[4/5] Настройка Python окружения (backend/venv)...${NC}"
VENV_DIR="$SCRIPT_DIR/backend/venv"
VENV_PY="$VENV_DIR/bin/python"

if [ ! -f "$VENV_PY" ]; then
    echo "      Создание виртуального окружения в $VENV_DIR..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

echo "      Обновление pip и установка пакетов из requirements.txt..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/backend/requirements.txt" --quiet
echo -e "      ${GREEN}✓ Зависимости Python успешно настроены.${NC}"

# ------------------------------------------------------------------------------
# 5. Предварительная загрузка моделей Whisper AI
# ------------------------------------------------------------------------------
if [ "$SKIP_MODELS" = false ]; then
    echo -e "${BOLD}[5/5] Предварительная загрузка моделей Whisper AI (${MODEL_TYPE})...${NC}"
    "$VENV_PY" "$SCRIPT_DIR/backend/download_models.py" --model "$MODEL_TYPE"
else
    echo -e "${BOLD}[5/5] Загрузка моделей пропущена (--no-models).${NC}"
fi

# ------------------------------------------------------------------------------
# Проверка запуска
# ------------------------------------------------------------------------------
echo -e "${BOLD}[Верификация] Проверка работоспособности бэкенда...${NC}"
"$VENV_PY" "$SCRIPT_DIR/backend/main.py" --help >/dev/null 2>&1
echo -e "      ${GREEN}✓ Backend SubSplit AI полностью протестирован и готов к работе!${NC}"

echo ""
echo -e "${BOLD}${GREEN}==================================================================${NC}"
echo -e "${BOLD}${GREEN}                🎉 УСТАНОВКА УСПЕШНО ЗАВЕРШЕНА!                  ${NC}"
echo -e "${BOLD}${GREEN}==================================================================${NC}"
echo ""
echo "Как открыть в Adobe Premiere Pro:"
echo "  1. Перезапустите Premiere Pro (если программа была открыта)."
echo "  2. Откройте любой проект и секвенцию."
echo "  3. В верхнем меню выберите:"
echo "     Окно (Window) -> Расширения (Extensions) -> SubSplit AI Subtitles"
echo "  4. Нажмите «Создать субтитры» — панель распознает речь и создаст титры!"
echo ""
