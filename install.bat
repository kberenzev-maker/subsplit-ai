@echo off
chcp 65001 >nul
echo.
echo ==================================================================
echo       SubSplit AI: Установка для Adobe Premiere Pro (Windows)
echo ==================================================================
echo.

:: 1. PlayerDebugMode
echo [1/5] Включение режима разработчика Adobe CEP (PlayerDebugMode)...
for %%v in (8 9 10 11 12 13 14 15 16 17 18 19 20 21 22) do (
    reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo       ✓ Режим отладки успешно активирован в реестре.

:: 2. Директория Adobe CEP
echo [2/5] Подключение плагина в папку Adobe CEP...
set "CEP_DIR=%APPDATA%\Adobe\CEP\extensions"
if not exist "%CEP_DIR%" mkdir "%CEP_DIR%"
set "TARGET_DIR=%CEP_DIR%\com.antigravity.subsplit"
set "CURRENT_DIR=%~dp0"
if "%CURRENT_DIR:~-1%"=="\" set "CURRENT_DIR=%CURRENT_DIR:~0,-1%"

if exist "%TARGET_DIR%" rmdir /s /q "%TARGET_DIR%" 2>nul
mklink /J "%TARGET_DIR%" "%CURRENT_DIR%" 2>nul || xcopy /E /I /Y "%CURRENT_DIR%" "%TARGET_DIR%"
echo       ✓ Плагин подключен: %TARGET_DIR%

:: 3. Проверка Python
echo [3/5] Проверка Python 3...
where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ОШИБКА] Python не обнаружен в PATH!
    echo Установите Python 3.10-3.12 с официального сайта https://www.python.org/
    echo Обязательно отметьте галочку "Add python.exe to PATH" при установке.
    echo.
    pause
    exit /b 1
)
echo       ✓ Python найден в системе.

:: 4. Виртуальное окружение
echo [4/5] Настройка Python окружения (backend\venv)...
if not exist "%CURRENT_DIR%\backend\venv\Scripts\python.exe" (
    python -m venv "%CURRENT_DIR%\backend\venv"
)
call "%CURRENT_DIR%\backend\venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
call "%CURRENT_DIR%\backend\venv\Scripts\python.exe" -m pip install -r "%CURRENT_DIR%\backend\requirements.txt" --quiet
echo       ✓ Зависимости Python успешно установлены.

:: 5. Загрузка моделей
echo [5/5] Загрузка и кэширование моделей нейросети Whisper...
call "%CURRENT_DIR%\backend\venv\Scripts\python.exe" "%CURRENT_DIR%\backend\download_models.py" --model turbo

echo.
echo ==================================================================
echo                УСТАНОВКА УСПЕШНО ЗАВЕРШЕНА!
echo ==================================================================
echo.
echo Как открыть в Adobe Premiere Pro:
echo 1. Перезапустите Premiere Pro.
echo 2. Откройте проект и перейдите в меню:
echo    Window (Окно) -^> Extensions (Расширения) -^> SubSplit AI Subtitles
echo.
pause
