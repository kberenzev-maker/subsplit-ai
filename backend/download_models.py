"""
SubSplit AI Model Downloader & Health Check.
Pre-downloads Whisper speech recognition models (MLX Metal for Apple Silicon,
Faster-Whisper for CPU/NVIDIA) so the user doesn't face unexpected download delays
during their first subtitle generation in Adobe Premiere Pro.
"""

import os
import sys
import argparse
import platform
import time
from typing import List

# Mapping of short names to HuggingFace / Faster-Whisper model IDs
MODEL_MAP = {
    "turbo": {
        "faster_whisper": "large-v3-turbo",
        "mlx": "mlx-community/whisper-large-v3-turbo",
        "description": "Whisper Large V3 Turbo (Высокая скорость и максимальная точность, ~1.6 ГБ)"
    },
    "large-v3-turbo": {
        "faster_whisper": "large-v3-turbo",
        "mlx": "mlx-community/whisper-large-v3-turbo",
        "description": "Whisper Large V3 Turbo (~1.6 ГБ)"
    },
    "small": {
        "faster_whisper": "small",
        "mlx": None,
        "description": "Whisper Small (Легкая модель для слабых систем, ~460 МБ)"
    },
    "medium": {
        "faster_whisper": "medium",
        "mlx": None,
        "description": "Whisper Medium (Сбалансированная модель, ~1.5 ГБ)"
    },
    "base": {
        "faster_whisper": "base",
        "mlx": None,
        "description": "Whisper Base (Быстрая модель для простых задач, ~140 МБ)"
    }
}


def is_apple_silicon() -> bool:
    """Проверяет, работает ли скрипт на Apple Silicon Mac (M1/M2/M3/M4)."""
    return sys.platform == "darwin" and platform.machine() == "arm64"


def download_mlx_model(repo_id: str, force: bool = False) -> bool:
    """Скачивает модель MLX для Apple Silicon Metal GPU."""
    try:
        from huggingface_hub import snapshot_download
        print(f"\n[MLX GPU] Проверка и загрузка весов: {repo_id}...")
        t0 = time.time()
        local_dir = snapshot_download(
            repo_id=repo_id,
            force_download=force
        )
        elapsed = round(time.time() - t0, 1)
        print(f"✓ MLX модель готова ({elapsed} сек): {local_dir}")
        return True
    except Exception as e:
        print(f"✗ Ошибка загрузки MLX модели: {e}", file=sys.stderr)
        return False


def download_faster_whisper_model(model_name: str, force: bool = False) -> bool:
    """Скачивает модель faster-whisper через CTranslate2 / Hugging Face."""
    try:
        from faster_whisper import WhisperModel
        print(f"\n[Faster-Whisper] Проверка и загрузка весов: {model_name}...")
        t0 = time.time()
        # Инициализация WhisperModel с device='cpu' скачивает и проверяет модель в ~/.cache/huggingface/hub/
        # Если модель уже есть, это занимает ~0.1 сек
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        del model
        elapsed = round(time.time() - t0, 1)
        print(f"✓ Faster-Whisper модель готова ({elapsed} сек)")
        return True
    except Exception as e:
        print(f"✗ Ошибка загрузки Faster-Whisper модели: {e}", file=sys.stderr)
        return False


def verify_models(test_mlx: bool = True) -> bool:
    """Проверяет работоспособность инференса на синтетическом сигнале."""
    print("\n[Диагностика] Быстрый тест инференса...")
    import numpy as np

    # 0.5 сек тишины на 16 кГц
    dummy_audio = np.zeros(8000, dtype=np.float32)

    if test_mlx and is_apple_silicon():
        try:
            import mlx_whisper
            print("  - Проверка Metal GPU инференса (mlx-whisper)...")
            res = mlx_whisper.transcribe(
                dummy_audio,
                path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
                language="ru",
                word_timestamps=True
            )
            print("  ✓ Metal GPU инференс работает корректно!")
        except Exception as e:
            print(f"  ! Замечание по Metal GPU ({e}), будет использоваться CPU fallback.")

    try:
        from faster_whisper import WhisperModel
        print("  - Проверка CPU инференса (faster-whisper)...")
        m = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
        segs, _ = m.transcribe(dummy_audio, language="ru")
        list(segs)
        print("  ✓ Faster-Whisper CPU инференс работает корректно!")
    except Exception as e:
        print(f"  ✗ Ошибка теста faster-whisper: {e}")
        return False

    return True


def main():
    parser = argparse.ArgumentParser(description="SubSplit AI Model Downloader")
    parser.add_argument(
        "--model",
        type=str,
        default="turbo",
        choices=["turbo", "large-v3-turbo", "small", "medium", "base", "all"],
        help="Какую модель скачать (по умолчанию turbo)"
    )
    parser.add_argument("--force", action="store_true", help="Принудительно перезагрузить кэш")
    parser.add_argument("--skip-verify", action="store_true", help="Пропустить верификацию инференса")
    parser.add_argument("--list", action="store_true", help="Показать список доступных моделей")
    args = parser.parse_args()

    if args.list:
        print("\nДоступные модели Whisper в SubSplit AI:")
        for k, v in MODEL_MAP.items():
            if k == "large-v3-turbo":
                continue
            print(f"  • {k:10} - {v['description']}")
        return

    print("=" * 60)
    print("      SubSplit AI: Предварительная загрузка моделей Whisper    ")
    print("=" * 60)
    print(f"Платформа: {platform.system()} ({platform.machine()})")
    apple_m = is_apple_silicon()
    print(f"Apple Silicon Metal GPU ускорение: {'Да (доступно)' if apple_m else 'Нет (CPU/CUDA)'}")

    models_to_download: List[str] = []
    if args.model == "all":
        models_to_download = ["turbo", "small", "medium", "base"]
    else:
        models_to_download = [args.model]

    success = True
    for m in models_to_download:
        info = MODEL_MAP.get(m, MODEL_MAP["turbo"])
        print(f"\n--- Модель: {m} ---")
        print(info["description"])

        # 1. Если Apple Silicon и есть MLX версия
        if apple_m and info.get("mlx"):
            ok_mlx = download_mlx_model(info["mlx"], force=args.force)
            if not ok_mlx:
                success = False

        # 2. Faster-Whisper версия (CPU/резерв)
        if info.get("faster_whisper"):
            ok_fw = download_faster_whisper_model(info["faster_whisper"], force=args.force)
            if not ok_fw:
                success = False

    if not args.skip_verify:
        verify_models(test_mlx=apple_m)

    print("\n" + "=" * 60)
    if success:
        print("✓ Все необходимые модели успешно подготовлены и закэшированы!")
        print("  При работе в Premiere Pro транскрибация запустится мгновенно.")
    else:
        print("! Некоторые модели завершились с предупреждением.")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
