"""
LLM Chunker: Semantic & syntactic subtitle segmentation using local Ollama.
Uses linguistic AI reasoning to divide speech into natural, rhythmic speech chunks (синтагмы)
for Reels, Shorts, and TikTok with 100% accurate Whisper word-level timestamps.
Seamlessly falls back to DP chunker if Ollama is unavailable.
"""

import re
import json
import time
import shutil
import subprocess
import os
import urllib.request
from typing import List, Dict, Any, Optional
from chunker import chunk_words, format_subtitle_text, clean_word, has_sentence_end_punctuation


class OllamaSession:
    """
    On-demand менеджер Ollama:
    - Запускает процесс только на момент обработки запроса.
    - Автоматически завершает процесс и полностью освобождает память (0 MB) по окончании.
    """
    def __init__(self, host: str = "http://127.0.0.1:11434"):
        self.host = host
        self.proc = None
        self.started_by_us = False

    def __enter__(self):
        if check_ollama_server(self.host)["running"]:
            return self

        ollama_bin = shutil.which("ollama") or "/opt/homebrew/bin/ollama"
        if os.path.exists(ollama_bin) and os.access(ollama_bin, os.X_OK):
            try:
                print("STATUS:Запуск Ollama по требованию...", flush=True)
                self.proc = subprocess.Popen(
                    [ollama_bin, "serve"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
                self.started_by_us = True
                start_t = time.time()
                while time.time() - start_t < 5.0:
                    if check_ollama_server(self.host)["running"]:
                        break
                    time.sleep(0.1)
            except Exception as e:
                print(f"STATUS:Не удалось запустить Ollama: {e}", flush=True)

        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        unload_ollama_model(host=self.host)
        if self.started_by_us and self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2.0)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
            print("STATUS:Ollama остановлена, оперативная память полностью освобождена (0 МБ).", flush=True)


def unload_ollama_model(model: str = "", host: str = "http://127.0.0.1:11434"):
    """Принудительно выгружает модель из VRAM/RAM (keep_alive: 0)."""
    try:
        data = json.dumps({"model": model or "qwen2.5:3b", "keep_alive": 0}).encode('utf-8')
        req = urllib.request.Request(f"{host}/api/generate", data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=2.0):
            pass
    except Exception:
        pass


def check_ollama_server(host: str = "http://127.0.0.1:11434") -> Dict[str, Any]:
    """Проверяет доступность Ollama и возвращает список установленных моделей."""
    try:
        req = urllib.request.Request(f"{host}/api/tags", headers={"User-Agent": "SubSplit"})
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode('utf-8'))
                models = [m.get('name', '') for m in data.get('models', [])]
                return {
                    "running": True,
                    "models": models
                }
    except Exception:
        pass
    return {"running": False, "models": []}


def get_preferred_model(available_models: List[str]) -> str:
    """Выбирает лучшую имеющуюся модель для русского синтаксиса и перевода."""
    preferences = ["qwen2.5:7b", "qwen2.5:14b", "qwen2.5:latest", "qwen2.5:3b", "qwen2.5:1.5b", "llama3.1:8b", "llama3:8b", "saiga", "mistral"]
    for pref in preferences:
        for m in available_models:
            if pref in m:
                return m
    return available_models[0] if available_models else "qwen2.5:3b"


def split_words_into_utterances(words: List[Dict[str, Any]], max_sentence_len: int = 25) -> List[List[Dict[str, Any]]]:
    """
    Разбивает общий поток слов на естественные предложения/клаузы для отправки в LLM.
    Разделители: знаки конца предложения (.!?), длинные паузы (>0.75с) или длина > max_sentence_len.
    """
    if not words:
        return []

    utterances = []
    current = []

    for i, w in enumerate(words):
        current.append(w)
        
        is_last = (i == len(words) - 1)
        if is_last:
            utterances.append(current)
            break

        next_w = words[i + 1]
        pause_gap = next_w['start'] - w['end']
        
        # Условия разрыва предложения:
        has_period = has_sentence_end_punctuation(w['text'])
        is_long_pause = (pause_gap > 0.75)
        is_too_long = (len(current) >= max_sentence_len)

        if has_period or is_long_pause or is_too_long:
            utterances.append(current)
            current = []

    return utterances


def request_ollama_chunking(
    text: str,
    max_words: int = 3,
    model: str = "qwen2.5:3b",
    host: str = "http://127.0.0.1:11434"
) -> Optional[str]:
    """
    Запрашивает у Ollama расстановку разделителей '|' между смысловыми тактами.
    """
    system_prompt = (
        "Ты — профессиональный редактор субтитров для динамичных вертикальных видео (Reels, TikTok, Shorts). "
        "Твоя задача — разбить русскую речь на короткие, логичные речевые такты (синтагмы).\n\n"
        f"СТРОГИЕ ПРАВИЛА:\n"
        f"1. В одном блоке от 1 до {max_words} слов (обычно 2-{max_words} слова).\n"
        "2. Имена собственные (имя + фамилия) НИКОГДА не разрывай: «Кента Кума», «Илон Маск».\n"
        "3. Разговорные фразы и обороты («ну что», «то есть», «так что») сохраняй неделимыми.\n"
        "4. Предлоги и союзы объединяй со следующим словом («и в какой-то», а не отдельно «и в»).\n"
        "5. Предлоги (в, на, с, из, к, от, по, не, как, и, но) НЕ должны оставаться в конце субтитра — переноси их к зависимому слову («в баню», «от природы»).\n"
        "6. Частицы (же, ли, бы) НЕ могут начинать новый субтитр («такая же», а не «же часть»).\n"
        "7. НЕ МЕНЯЙ, НЕ УДАЛЯЙ И НЕ ДОБАВЛЯЙ СЛОВА! Сохраняй исходные слова в точности.\n"
        "8. Раздели блоки субтитров символом '|'.\n"
        "9. Верни ТОЛЬКО разбитый текст с символами '|' без кавычек, префиксов и комментариев."
    )

    user_prompt = (
        "Примеры:\n"
        "Вход: и в какой-то момент сделал Кента Кума ну что вернемся\n"
        "Выход: и в какой-то | момент | сделал | Кента Кума | ну что | вернемся\n\n"
        "Вход: никогда не существует отдельно от природы\n"
        "Выход: никогда | не существует | отдельно | от природы\n\n"
        f"Вход: {text}\n"
        "Выход:"
    )

    payload = {
        "model": model,
        "prompt": f"{system_prompt}\n\n{user_prompt}",
        "stream": False,
        "keep_alive": "5m",  # Держит веса в памяти во время обработки серии предложений
        "options": {
            "temperature": 0.1,  # Минимальная температура для детерминированности
            "top_p": 0.9
        }
    }

    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            f"{host}/api/generate",
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            res = json.loads(resp.read().decode('utf-8'))
            return res.get("response", "").strip()
    except Exception as e:
        print(f"Ollama request error: {e}", flush=True)
        return None


def align_llm_chunks_with_words(
    llm_output: str,
    original_words: List[Dict[str, Any]],
    max_words: int = 3
) -> Optional[List[Dict[str, Any]]]:
    """
    Сопоставляет чанки из ответа LLM со списком слов с таймингами.
    Если LLM выдумала слова, пропустила слова или нарушила лимит слов, возвращает None (fallback).
    """
    # Очищаем ответ от возможных лишних тегов/кавычек
    cleaned_output = re.sub(r'^["\']|["\']$', '', llm_output.strip())
    raw_chunks = [c.strip() for c in cleaned_output.split('|') if c.strip()]
    
    if not raw_chunks:
        return None

    aligned = []
    word_cursor = 0
    total_words = len(original_words)

    for chunk_text in raw_chunks:
        chunk_tokens = chunk_text.split()
        if not chunk_tokens:
            continue
        
        k = len(chunk_tokens)
        # Проверяем лимит слов (с небольшим допуском, но не больше max_words + 1)
        if k > max_words + 1:
            return None

        if word_cursor + k > total_words:
            return None

        # Проверяем соответствие слов
        for j in range(k):
            orig_cleaned = clean_word(original_words[word_cursor + j]['text'])
            llm_cleaned = clean_word(chunk_tokens[j])
            if orig_cleaned != llm_cleaned:
                return None

        chunk_slice = original_words[word_cursor : word_cursor + k]
        start_time = chunk_slice[0]['start']
        end_time = chunk_slice[-1]['end']
        
        # Сохраняем исходный текст и пунктуацию
        raw_text = " ".join(w['text'].strip() for w in chunk_slice)

        aligned.append({
            'text': raw_text,
            'start': start_time,
            'end': end_time,
            'words': chunk_slice
        })
        word_cursor += k

    if word_cursor != total_words:
        return None

    return aligned


def chunk_words_semantic(
    words_with_timing: List[Dict[str, Any]],
    max_words: int = 3,
    model: str = "qwen2.5:3b",
    host: str = "http://127.0.0.1:11434",
    text_case: str = "default",
    remove_chars: str = ""
) -> List[Dict[str, Any]]:
    """
    Главный пайплайн семантического разбиения через Ollama.
    Если Ollama недоступна или ответ не прошел верификацию — прозрачно откатывается на DP Chunker.
    """
    if not words_with_timing:
        return []

    server_status = check_ollama_server(host)
    if not server_status["running"]:
        print("STATUS:Ollama не запущена, используем быстрый локальный DP-алгоритм...", flush=True)
        return chunk_words(words_with_timing, max_words=max_words, text_case=text_case, remove_chars=remove_chars)

    chosen_model = get_preferred_model(server_status["models"]) if server_status["models"] else model
    print(f"STATUS:Умное синтагматическое разбиение через Ollama ({chosen_model})...", flush=True)

    utterances = split_words_into_utterances(words_with_timing)
    all_subtitles = []

    try:
        for utt in utterances:
            utt_text = " ".join(w['text'].strip() for w in utt)
            llm_resp = request_ollama_chunking(utt_text, max_words=max_words, model=chosen_model, host=host)
            
            aligned = None
            if llm_resp:
                aligned = align_llm_chunks_with_words(llm_resp, utt, max_words=max_words)

            if aligned:
                all_subtitles.extend(aligned)
            else:
                # Fallback для данного предложения на математический DP
                fallback_subs = chunk_words(utt, max_words=max_words)
                all_subtitles.extend(fallback_subs)
    finally:
        # Сразу выгружаем модель из оперативной/видео памяти
        unload_ollama_model(chosen_model, host)

    # Применяем стилевое форматирование и нумерацию
    formatted_subtitles = []
    for i, sub in enumerate(all_subtitles, 1):
        styled = format_subtitle_text(sub['text'], text_case=text_case, remove_chars=remove_chars)
        formatted_subtitles.append({
            'index': i,
            'text': styled,
            'start': sub['start'],
            'end': sub['end'],
            'words': sub.get('words', [])
        })

    # Сглаживание микропауз
    for i in range(len(formatted_subtitles) - 1):
        gap = formatted_subtitles[i + 1]['start'] - formatted_subtitles[i]['end']
        if 0 < gap < 0.15:
            formatted_subtitles[i]['end'] = round(formatted_subtitles[i + 1]['start'] - 0.02, 3)

    return formatted_subtitles
