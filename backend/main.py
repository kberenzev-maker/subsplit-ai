"""
Main CLI & Backend Controller for SubSplit AI.
Coordinates transcription, proofreading, DP chunking, and SRT generation.
"""

import sys
import os
import argparse
import subprocess
import tempfile
import shutil
import traceback
from transcribe import transcribe_audio
from proofread import proofread_words
from chunker import chunk_words
from srt_parser import write_srt, parse_srt_to_words


def get_ffmpeg_path() -> str:
    """Определяет рабочий путь к бинарнику ffmpeg."""
    candidates = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        shutil.which("ffmpeg")
    ]
    for p in candidates:
        if p and os.path.exists(p) and os.access(p, os.X_OK):
            return p
    return "ffmpeg"


def extract_audio(input_media: str) -> str:
    """
    Извлекает аудио из видео/аудио файла в формате 16kHz mono WAV через ffmpeg.
    """
    if not os.path.exists(input_media):
        raise FileNotFoundError(f"Файл не найден: {input_media}")

    # Если файл уже является WAV, проверяем его
    if input_media.lower().endswith(".wav"):
        return input_media

    ffmpeg_bin = get_ffmpeg_path()
    temp_wav = tempfile.mktemp(suffix="_subsplit.wav")
    print(f"STATUS:Извлечение аудио дорожки через ffmpeg...", flush=True)

    cmd = [
        ffmpeg_bin, "-y",
        "-i", input_media,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        temp_wav
    ]

    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if res.returncode != 0:
            err_msg = res.stderr.decode('utf-8', errors='ignore')
            raise RuntimeError(f"Ошибка ffmpeg: {err_msg[:300]}")
    except subprocess.TimeoutExpired:
        raise RuntimeError("Превышено время ожидания извлечения аудио ffmpeg (>120 сек).")

    return temp_wav


def process_audio(
    input_path: str,
    output_srt: str,
    max_words: int = 2,
    max_lines: int = 2,
    model_size: str = "medium",
    language: str = "ru",
    use_proofread: bool = True,
    use_ollama: bool = False,
    text_case: str = "default",
    remove_chars: str = "",
    translate: bool = False,
    src_lang: str = "auto",
    tgt_lang: str = "ru",
    dual_track: bool = False,
    output_foreign_srt: str = ""
):
    """Полный пайплайн: извлечение -> Whisper -> Вычитка / Перевод -> DP Chunker -> SRT"""
    temp_audio = None
    created_temp = False
    try:
        # 1. Извлечение аудио
        extracted = extract_audio(input_path)
        if extracted != input_path:
            temp_audio = extracted
            created_temp = True

        # 2. Транскрибация Whisper с посекундными словами
        whisper_lang = None if (translate and src_lang == "auto") else (src_lang if translate else language)
        words = transcribe_audio(extracted, model_size=model_size, language=whisper_lang)

        if not words:
            print("ERROR:Не удалось распознать слова в аудио.", flush=True)
            sys.exit(1)

        # 3. Вычитка / Перевод и 4. Умная нарезка
        style_desc = []
        if text_case == "upper": style_desc.append("CAPS")
        elif text_case == "lower": style_desc.append("строчные")
        if remove_chars: style_desc.append(f"без знаков '{remove_chars}'")
        extra_str = f" [{', '.join(style_desc)}]" if style_desc else ""

        if translate:
            from translator import process_bilingual_translation
            from llm_chunker import OllamaSession
            with OllamaSession():
                res_bilingual = process_bilingual_translation(
                    words=words,
                    src_lang=src_lang,
                    tgt_lang=tgt_lang,
                    max_words=max_words,
                    text_case=text_case,
                    remove_chars=remove_chars,
                    use_proofread=use_proofread
                )

                subtitles_trans = res_bilingual["translated"]
                subtitles_foreign = res_bilingual["original_foreign"]

                # Запись готового SRT перевода
                os.makedirs(os.path.dirname(os.path.abspath(output_srt)), exist_ok=True)
                write_srt(subtitles_trans, output_srt)

                # Запись второй дорожки (оригинал на иностранном языке) если требуется
                if dual_track and subtitles_foreign:
                    if not output_foreign_srt:
                        base, ext = os.path.splitext(output_srt)
                        output_foreign_srt = f"{base}_Original_{src_lang.upper()}{ext}"
                    os.makedirs(os.path.dirname(os.path.abspath(output_foreign_srt)), exist_ok=True)
                    write_srt(subtitles_foreign, output_foreign_srt)
                    print(f"SUCCESS_DUAL:{output_srt}|{output_foreign_srt}", flush=True)
                    print(f"STATUS:Готово! Созданы 2 дорожки: перевод ({len(subtitles_trans)} субт.) и оригинал ({len(subtitles_foreign)} субт.).", flush=True)
                else:
                    print(f"SUCCESS:{output_srt}", flush=True)
                    print(f"STATUS:Готово! Сформировано {len(subtitles_trans)} блоков субтитров.", flush=True)

        elif use_ollama:
            from llm_chunker import chunk_words_semantic, OllamaSession
            with OllamaSession():
                if use_proofread:
                    print("STATUS:Локальная вычитка и проверка орфографии...", flush=True)
                    words = proofread_words(words, use_ollama=True)
                print(f"STATUS:Умная нарезка через Ollama (макс. {max_words} сл., синтагмы){extra_str}...", flush=True)
                subtitles = chunk_words_semantic(words, max_words=max_words, text_case=text_case, remove_chars=remove_chars)
                os.makedirs(os.path.dirname(os.path.abspath(output_srt)), exist_ok=True)
                write_srt(subtitles, output_srt)
                print(f"SUCCESS:{output_srt}", flush=True)
                print(f"STATUS:Готово! Сформировано {len(subtitles)} блоков субтитров.", flush=True)
        else:
            if use_proofread:
                print("STATUS:Локальная вычитка и проверка орфографии...", flush=True)
                words = proofread_words(words, use_ollama=False)
            print(f"STATUS:Умная нарезка субтитров (макс. {max_words} сл., до {max_lines} стр.){extra_str}...", flush=True)
            subtitles = chunk_words(words, max_words=max_words, max_lines=max_lines, text_case=text_case, remove_chars=remove_chars)
            os.makedirs(os.path.dirname(os.path.abspath(output_srt)), exist_ok=True)
            write_srt(subtitles, output_srt)
            print(f"SUCCESS:{output_srt}", flush=True)
            print(f"STATUS:Готово! Сформировано {len(subtitles)} блоков субтитров.", flush=True)

    finally:
        if created_temp and temp_audio and os.path.exists(temp_audio):
            try:
                os.remove(temp_audio)
            except Exception:
                pass
        # Очищаем временный аудиофайл таймлайна в /tmp (освобождаем диск)
        if input_path and os.path.basename(input_path).startswith("seq_audio_") and os.path.exists(input_path):
            try:
                os.remove(input_path)
            except Exception:
                pass


def process_existing_srt(
    input_srt: str,
    output_srt: str,
    max_words: int = 2,
    max_lines: int = 2,
    use_proofread: bool = True,
    use_ollama: bool = False,
    text_case: str = "default",
    remove_chars: str = ""
):
    """Пайплайн переразбивки уже существующего SRT файла из Premiere"""
    print(f"STATUS:Чтение исходного SRT: {input_srt}...", flush=True)
    words = parse_srt_to_words(input_srt)
    
    if not words:
        print("ERROR:Файл SRT пуст или имеет неверный формат.", flush=True)
        sys.exit(1)

    style_desc = []
    if text_case == "upper": style_desc.append("CAPS")
    elif text_case == "lower": style_desc.append("строчные")
    if remove_chars: style_desc.append(f"без знаков '{remove_chars}'")
    extra_str = f" [{', '.join(style_desc)}]" if style_desc else ""

    if use_ollama:
        from llm_chunker import chunk_words_semantic, OllamaSession
        with OllamaSession():
            if use_proofread:
                print("STATUS:Проверка грамматики и орфографии...", flush=True)
                words = proofread_words(words, use_ollama=True)
            print(f"STATUS:Умная нарезка через Ollama (макс. {max_words} сл., синтагмы){extra_str}...", flush=True)
            subtitles = chunk_words_semantic(words, max_words=max_words, text_case=text_case, remove_chars=remove_chars)
    else:
        if use_proofread:
            print("STATUS:Проверка грамматики и орфографии...", flush=True)
            words = proofread_words(words, use_ollama=False)
        print(f"STATUS:Перенарезка субтитров (макс. {max_words} сл., до {max_lines} стр.){extra_str}...", flush=True)
        subtitles = chunk_words(words, max_words=max_words, max_lines=max_lines, text_case=text_case, remove_chars=remove_chars)

    os.makedirs(os.path.dirname(os.path.abspath(output_srt)), exist_ok=True)
    write_srt(subtitles, output_srt)
    print(f"SUCCESS:{output_srt}", flush=True)
    print(f"STATUS:Готово! Сформировано {len(subtitles)} блоков субтитров.", flush=True)


def main():
    parser = argparse.ArgumentParser(description="SubSplit AI Subtitle Generator for Premiere Pro")
    parser.add_argument("--mode", choices=["transcribe", "rechunk_srt"], default="transcribe")
    parser.add_argument("--input", required=True, help="Путь к видео/аудио файлу или SRT")
    parser.add_argument("--output", required=True, help="Путь для сохранения готового SRT")
    parser.add_argument("--max-words", type=int, default=2, help="Максимум слов на экран (по умолчанию 2)")
    parser.add_argument("--max-lines", type=int, default=2, choices=[1, 2, 3], help="Максимум строк на экран (1, 2 или 3, по умолчанию 2)")
    parser.add_argument("--model", default="large-v3-turbo", choices=["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "turbo"])
    parser.add_argument("--lang", default="ru", help="Язык распознавания (ru)")
    parser.add_argument("--no-proofread", action="store_true", help="Отключить проверку орфографии")
    parser.add_argument("--use-ollama", action="store_true", help="Использовать локальную нейросеть Ollama")
    parser.add_argument("--text-case", choices=["default", "upper", "lower"], default="default", help="Регистр текста")
    parser.add_argument("--remove-chars", default="", help="Символы для удаления (например 'all' или '.,?!')")
    parser.add_argument("--translate", action="store_true", help="Включить мультиязычный перевод через Ollama")
    parser.add_argument("--src-lang", default="auto", help="Исходный язык речи (auto, ru, en, es, de, fr)")
    parser.add_argument("--tgt-lang", default="ru", help="Целевой язык перевода (ru, en, es, de, fr)")
    parser.add_argument("--dual-track", action="store_true", help="Генерировать две дорожки (перевод + оригинал)")
    parser.add_argument("--output-foreign", default="", help="Путь для сохранения SRT оригинальной речи")

    args = parser.parse_args()
    use_proof = not args.no_proofread

    try:
        if args.mode == "transcribe":
            process_audio(
                input_path=args.input,
                output_srt=args.output,
                max_words=args.max_words,
                max_lines=args.max_lines,
                model_size=args.model,
                language=args.lang,
                use_proofread=use_proof,
                use_ollama=args.use_ollama,
                text_case=args.text_case,
                remove_chars=args.remove_chars,
                translate=args.translate,
                src_lang=args.src_lang,
                tgt_lang=args.tgt_lang,
                dual_track=args.dual_track,
                output_foreign_srt=args.output_foreign
            )
        elif args.mode == "rechunk_srt":
            process_existing_srt(
                input_srt=args.input,
                output_srt=args.output,
                max_words=args.max_words,
                max_lines=args.max_lines,
                use_proofread=use_proof,
                use_ollama=args.use_ollama,
                text_case=args.text_case,
                remove_chars=args.remove_chars
            )
    except Exception as e:
        print(f"ERROR:{str(e)}", flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
