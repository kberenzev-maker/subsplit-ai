"""
Proofreader module: Corrects grammar, punctuation, and common speech recognition
errors in Russian locally without cloud dependencies. Also supports optional Ollama.
"""

import re
import urllib.request
import json
from typing import List, Dict, Any

_STRIP_PUNCT = ' \t\n\r.,!?:;—–-"\'«»()[]{}*`~…'
_SENTENCE_END_PUNCT = ('.', '!', '?', '…')
_CLAUSE_BOUNDARY_PUNCT = (',', '.', '!', '?', '…', ':', ';', '—', '–', '-')

# Однословные частые ошибки транскрибации (O(1) поиск)
SINGLE_WORD_FIXES = {
    'вообщем': 'в общем',
    'вобщем': 'в общем',
    'так-же': 'также',
    'то-есть': 'то есть',
    'врядли': 'вряд ли',
    'все-таки': 'всё-таки',
    'как-будто': 'как будто',
    'по-скольку': 'поскольку',
    'на-верняка': 'наверняка',
    'по-этому': 'поэтому',
    'не-ужели': 'неужели',
}

# Двусловные распространенные акустические склейки/ошибки
TWO_WORD_FIXES = {
    ('в', 'смысли'): ('в', 'смысле'),
    ('по', 'скольку'): ('поскольку', ''),
    ('из', 'за'): ('из-за', ''),
    ('из', 'под'): ('из-под', ''),
    ('все', 'таки'): ('всё-таки', ''),
    ('всё', 'таки'): ('всё-таки', ''),
    ('на', 'верняка'): ('наверняка', ''),
    ('не', 'ужели'): ('неужели', ''),
    ('вряд', 'ли'): ('вряд', 'ли'),
}

# Союзы, перед которыми в русском языке ставится запятая (если перед ними не стоит союз/частица)
COMMA_CONJUNCTIONS = {
    "что", "чтобы", "чтоб", "когда", "который", "которая", "которое", "которые",
    "которого", "которой", "которому", "которым", "которыми", "котором", "которую", "которых",
    "где", "куда", "откуда", "почему", "зачем", "как", "если", "хотя",
    "но", "а", "дабы", "поскольку", "зато", "однако"
}

# Слова (союзы, частицы, предлоги, усилители), ПОСЛЕ которых НЕ ставится запятая
# перед подчинительными союзами ("А что делает", "и как мы", "не то что", "потому что")
NO_COMMA_AFTER_WORDS = {
    "а", "и", "но", "да", "или", "либо", "не", "ни", "ну", "вот", "ведь",
    "даже", "только", "лишь", "просто", "именно", "особенно", "почти",
    "совсем", "прямо", "ровно", "точно", "будто", "словно", "якобы",
    "потому", "оттого", "так", "тогда", "после", "перед", "вместо",
    "кроме", "сверх", "внутри", "среди", "вроде", "типа", "будь", "хоть",
    "разве", "неужели", "вряд", "едва", "чуть", "зато", "однако", "же",
    "бы", "б", "ли", "в", "во", "на", "с", "со", "к", "ко", "о", "об",
    "у", "за", "из", "от", "по", "до", "для", "при", "про", "без", "через"
}

# Составные союзы, где запятая ставится ПЕРЕД первым словом ("..., потому что", "..., так как")
COMPOUND_COMMA_PREFIXES = {
    ("потому", "что"),
    ("оттого", "что"),
    ("так", "что"),
    ("так", "как"),
    ("для", "того"),
    ("вместо", "того"),
    ("после", "того"),
    ("перед", "тем"),
    ("несмотря", "на"),
}


def rule_based_correction(words: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Быстрая локальная коррекция списка распознанных слов:
    - O(1) исправление распространенных орфографических ошибок.
    - Грамотная расстановка запятых перед союзами (без ложных запятых в 'А что', 'и как', 'потому что').
    - Капитализация первого слова в предложении.
    - Сохранение точных таймингов.
    """
    if not words:
        return []

    try:
        from chunker import merge_broken_tokens
        words = merge_broken_tokens(words)
    except Exception:
        pass

    n = len(words)
    if n == 0:
        return []

    # 1. Пословная коррекция, пунктуация и капитализация
    for i in range(n):
        item = words[i]
        raw_text = item['text'].strip()
        if not raw_text:
            continue

        # Капитализация первого слова или после точки/воскл./вопр. знака
        if i == 0 or (i > 0 and words[i - 1]['text'].rstrip(' "»\'').endswith(_SENTENCE_END_PUNCT)):
            if not raw_text[0].isupper():
                raw_text = raw_text[0].upper() + raw_text[1:]

        cleaned = raw_text.strip(_STRIP_PUNCT).lower().replace('ё', 'е')

        # Проверка союзов для запятой (только внутри одной фразы без длинной паузы и только для кириллицы)
        if i > 0 and cleaned in COMMA_CONJUNCTIONS:
            prev_text = words[i - 1]['text'].rstrip()
            prev_clean = prev_text.strip(_STRIP_PUNCT).lower().replace('ё', 'е')
            pause_gap = float(item.get('start', 0.0)) - float(words[i - 1].get('end', 0.0))
            is_prev_cyrillic = any('а' <= ch <= 'я' or ch == 'ё' for ch in prev_clean)

            if pause_gap <= 0.65 and is_prev_cyrillic:
                # Если это составной союз ("потому что", "так как"), ставим запятую ПЕРЕД первым словом
                if (prev_clean, cleaned) in COMPOUND_COMMA_PREFIXES:
                    if i >= 2:
                        prev2_text = words[i - 2]['text'].rstrip()
                        prev2_clean = prev2_text.strip(_STRIP_PUNCT).lower().replace('ё', 'е')
                        if prev2_text and not prev2_text.endswith(_CLAUSE_BOUNDARY_PUNCT) and prev2_clean not in NO_COMMA_AFTER_WORDS:
                            words[i - 2]['text'] = prev2_text + ","
                            words[i - 2]['word'] = words[i - 2]['text']
                elif prev_text and not prev_text.endswith(_CLAUSE_BOUNDARY_PUNCT):
                    # Перед "а", "но", "зато", "однако" запятая ставится (кроме случая когда перед ними союз "и"/"да")
                    if cleaned in ("а", "но", "зато", "однако"):
                        if prev_clean not in ("и", "а", "но", "да", "или", "не", "ни", "ну"):
                            words[i - 1]['text'] = prev_text + ","
                            words[i - 1]['word'] = words[i - 1]['text']
                    elif prev_clean not in NO_COMMA_AFTER_WORDS:
                        words[i - 1]['text'] = prev_text + ","
                        words[i - 1]['word'] = words[i - 1]['text']

        # Однословные замены
        if cleaned in SINGLE_WORD_FIXES:
            replacement = SINGLE_WORD_FIXES[cleaned]
            if raw_text[0].isupper():
                replacement = replacement[0].upper() + replacement[1:]
            # Сохраняем пунктуацию в конце (например, "вообщем," -> "в общем,")
            trailing = raw_text[len(raw_text.rstrip(_STRIP_PUNCT)):]
            raw_text = replacement + trailing

        words[i]['text'] = raw_text
        words[i]['word'] = raw_text

    # 2. Двусловные исправления (например, "в" + "смысли" -> "в" + "смысле")
    for i in range(n - 1):
        w1 = words[i]['text'].strip(_STRIP_PUNCT).lower().replace('ё', 'е')
        w2 = words[i + 1]['text'].strip(_STRIP_PUNCT).lower().replace('ё', 'е')
        pair = (w1, w2)
        if pair in TWO_WORD_FIXES:
            fix1, fix2 = TWO_WORD_FIXES[pair]
            t1 = words[i]['text']
            t2 = words[i + 1]['text']
            trailing1 = t1[len(t1.rstrip(_STRIP_PUNCT)):]
            trailing2 = t2[len(t2.rstrip(_STRIP_PUNCT)):]

            if t1 and t1[0].isupper():
                fix1 = fix1[0].upper() + fix1[1:]

            words[i]['text'] = fix1 + trailing1
            if fix2:
                words[i + 1]['text'] = fix2 + trailing2

    return words


def get_ollama_models(host: str = "http://127.0.0.1:11434") -> List[str]:
    """Возвращает список моделей Ollama."""
    try:
        req = urllib.request.Request(f"{host}/api/tags", headers={"User-Agent": "SubSplit"})
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode('utf-8'))
                return [m.get('name', '') for m in data.get('models', [])]
    except Exception:
        pass
    return []


def check_ollama_available(host: str = "http://127.0.0.1:11434") -> bool:
    """Проверяет доступность локального сервера Ollama."""
    return len(get_ollama_models(host)) >= 0 and check_ollama_ping(host)


def check_ollama_ping(host: str = "http://127.0.0.1:11434") -> bool:
    try:
        req = urllib.request.Request(f"{host}/api/tags", headers={"User-Agent": "SubSplit"})
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def proofread_with_ollama(text: str, model: str = "", host: str = "http://127.0.0.1:11434") -> str:
    """
    Если у пользователя запущен Ollama, проводит глубокую стилистическую вычитку.
    """
    if not model:
        models = get_ollama_models(host)
        for pref in ["qwen2.5:3b", "qwen2.5:latest", "qwen2.5:1.5b", "qwen2.5:7b", "llama3:8b"]:
            for m in models:
                if pref in m:
                    model = m
                    break
            if model:
                break
        if not model:
            model = models[0] if models else "qwen2.5:3b"

    prompt = (
        "Ты — профессиональный редактор субтитров. Твоя задача — исправить возможные "
        "ошибки транскрибации, опечатки и знаки препинания в следующем русском тексте. "
        "ВАЖНО: не добавляй лишних слов, не меняй смысл и порядок слов! "
        "Верни ТОЛЬКО исправленный текст без пояснений:\n\n"
        f"{text}"
    )

    try:
        data = json.dumps({
            "model": model,
            "prompt": prompt,
            "stream": False,
            "keep_alive": 0
        }).encode('utf-8')

        req = urllib.request.Request(
            f"{host}/api/generate",
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            res = json.loads(resp.read().decode('utf-8'))
            return res.get("response", "").strip()
    except Exception as e:
        print(f"Ollama proofreading error: {e}")
        return text


def proofread_words(words: List[Dict[str, Any]], use_ollama: bool = False) -> List[Dict[str, Any]]:
    """Основная функция вычитки слов."""
    # 1. Применяем надежные локальные правила
    words = rule_based_correction(words)

    # 2. Если включен Ollama и он запущен, можно дополнительно провалидировать
    if use_ollama and check_ollama_available():
        full_text = " ".join(w['text'] for w in words)
        corrected_text = proofread_with_ollama(full_text)
        corrected_tokens = corrected_text.split()
        
        # Если количество токенов совпало, переносим исправленный текст на тайминги
        if len(corrected_tokens) == len(words):
            for i, tok in enumerate(corrected_tokens):
                words[i]['text'] = tok

    return words
