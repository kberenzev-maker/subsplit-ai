"""
SRT Parser & Generator: Handles parsing of existing subtitle files
and generating compliant SRT files for Adobe Premiere Pro.
"""

import re
from typing import List, Dict, Any


def format_timestamp(seconds: float) -> str:
    """Конвертирует секунды в формат SRT таймкода: HH:MM:SS,mmm"""
    if seconds < 0:
        seconds = 0
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis >= 1000:
        secs += 1
        millis = 0
    return f"{hrs:02d}:{mins:02d}:{secs:02d},{millis:03d}"


def parse_timestamp(ts_str: str) -> float:
    """Конвертирует SRT таймкод (HH:MM:SS,mmm или HH:MM:SS.mmm) в секунды."""
    ts_str = ts_str.strip().replace(',', '.')
    parts = ts_str.split(':')
    if len(parts) == 3:
        hrs, mins, secs = parts
        return float(hrs) * 3600 + float(mins) * 60 + float(secs)
    elif len(parts) == 2:
        mins, secs = parts
        return float(mins) * 60 + float(secs)
    return float(ts_str)


def write_srt(subtitles: List[Dict[str, Any]], output_path: str):
    """
    Записывает список чанков субтитров в файл .srt.
    Формат каждого элемента: {'index': int, 'text': str, 'start': float, 'end': float}
    """
    with open(output_path, 'w', encoding='utf-8') as f:
        for i, sub in enumerate(subtitles, 1):
            start_str = format_timestamp(sub['start'])
            end_str = format_timestamp(sub['end'])
            text = sub['text'].strip()
            
            f.write(f"{i}\n")
            f.write(f"{start_str} --> {end_str}\n")
            f.write(f"{text}\n\n")


def parse_srt_to_words(srt_path: str) -> List[Dict[str, Any]]:
    """
    Читает существующий SRT файл (например, экспортированный из Premiere Pro)
    и разбивает его на отдельные слова с интерполированными таймингами.
    """
    with open(srt_path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()

    # Регулярка для блоков SRT
    pattern = re.compile(
        r'(\d+)\s*\n'
        r'(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})'
        r'(.*?)(?=\n\s*\d+\s*\n|\Z)',
        re.DOTALL
    )

    all_words = []

    for match in pattern.finditer(content):
        _, start_raw, end_raw, text_raw = match.groups()
        start = parse_timestamp(start_raw)
        end = parse_timestamp(end_raw)

        # Очищаем текст от HTML-тегов, переводов строк
        clean_text = re.sub(r'<[^>]+>', '', text_raw).strip()
        tokens = clean_text.split()
        if not tokens:
            continue

        # Интерполируем время на каждое слово блока
        duration = end - start
        word_duration = duration / len(tokens)

        for idx, token in enumerate(tokens):
            w_start = start + idx * word_duration
            w_end = w_start + word_duration
            all_words.append({
                'text': token,
                'start': round(w_start, 3),
                'end': round(w_end, 3)
            })

    try:
        from chunker import merge_broken_tokens
        all_words = merge_broken_tokens(all_words)
    except Exception:
        pass

    return all_words
