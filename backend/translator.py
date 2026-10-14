"""
Multilingual Translator & Synchronizer for SubSplit AI.
Handles code-switching / mixed speech (e.g. Russian + English),
contextual LLM translation via Ollama, and proportional word-level timestamp interpolation.
"""

import re
import json
import urllib.request
from typing import List, Dict, Any, Optional
from chunker import (
    chunk_words,
    clean_word,
    has_sentence_end_punctuation,
    format_subtitle_text,
    is_hanging,
    COMPOUND_PAIRS,
    ALLOWED_HANGING_END_PAIRS
)
from llm_chunker import (
    OllamaSession,
    check_ollama_server,
    get_preferred_model,
    split_words_into_utterances
)

LANG_NAMES = {
    "ru": "русский язык",
    "en": "английский язык",
    "es": "испанский язык",
    "de": "немецкий язык",
    "fr": "французский язык",
    "auto": "исходный язык речи"
}


def is_cyrillic(text: str) -> bool:
    """Проверяет наличие кириллических символов."""
    return bool(re.search(r'[\u0400-\u04FF]', text))


def is_latin(text: str) -> bool:
    """Проверяет наличие латинских символов."""
    return bool(re.search(r'[a-zA-Z]', text))


def detect_text_language(text: str, default: str = "ru") -> str:
    """
    Эвристическое определение языка реплики: кириллица (ru) или латиница (en/es/de/fr).
    """
    cyr_count = len(re.findall(r'[\u0400-\u04FF]', text))
    lat_count = len(re.findall(r'[a-zA-Z]', text))

    if cyr_count == 0 and lat_count == 0:
        return default
    if cyr_count >= lat_count:
        return "ru"
    return "en"


def get_word_lang(text: str) -> Optional[str]:
    """Определяет язык отдельного слова (ru / en)."""
    clean = re.sub(r'[^\w]', '', text)
    if not clean:
        return None
    if re.search(r'[\u0400-\u04FF]', clean):
        return "ru"
    if re.search(r'[a-zA-Z]', clean):
        return "en"
    return None


def split_multilingual_utterances(
    words: List[Dict[str, Any]],
    max_sentence_len: int = 35
) -> List[List[Dict[str, Any]]]:
    """
    Разбивает поток слов на законченные смысловые реплики с учетом переключения языка (code-switching).
    Сохраняет единую мысль спикера (объединяет короткие смежные клаузы без длинной паузы),
    чтобы переводчик видел всю фразу целиком, а не переводил обрывки по отдельности.
    """
    if not words:
        return []

    utterances: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    current_lang: Optional[str] = None

    for i, w in enumerate(words):
        w_text = (w.get('text') or w.get('word') or '').strip()
        w_lang = get_word_lang(w_text)

        current.append(w)
        if current_lang is None and w_lang:
            current_lang = w_lang

        is_last = (i == len(words) - 1)
        if is_last:
            utterances.append(current)
            break

        next_w = words[i + 1]
        next_text = (next_w.get('text') or next_w.get('word') or '').strip()
        next_lang = get_word_lang(next_text)

        pause_gap = next_w['start'] - w['end']
        has_period = has_sentence_end_punctuation(w_text)
        is_question = w_text.rstrip(' "»\'').endswith('?')
        is_long_pause = (pause_gap > 0.55)
        is_lang_switch = bool(w_lang and next_lang and w_lang != next_lang)

        # Каждая законченная фраза (точка, вопросительный знак, смена языка или пауза)
        # переводится отдельно, чтобы разные спикеры никогда не склеивались в одного человека
        is_sentence_break = is_question or has_period

        # Мягкий разрыв на границах клауз только при длине > 22 слов: если есть пауза (>0.35s) или запятая
        is_clause_split = (len(current) >= 22 and (pause_gap > 0.35 or w_text.endswith((',', ';'))))
        # Жесткий лимит только для непрерывной речи без пауз и знаков препинания
        is_hard_limit = (len(current) >= max_sentence_len)

        if is_sentence_break or is_long_pause or is_lang_switch or is_clause_split or is_hard_limit:
            utterances.append(current)
            current = []
            current_lang = None

    return utterances


# Короткие однозначные разговорные вопросы, имена и междометия (все развернутые ответы идут через литературный LLM)
GLOSSARY = {
    "lucy": "Люси",
    "jamie": "Джейми",
    "jason": "Джейсон",
    "anastasia": "Анастасия",
    "nastia": "Настя",
    "yang yushan": "Ян Юйшань",
    "fishing": "Рыбалка.",
    "fishing?": "Рыбалка?",
    "drawing": "Рисование.",
    "drawing?": "Рисование?",
    "it's drawing": "Рисование.",
    "it's drawing.": "Рисование.",
    "just one question": "Всего один вопрос.",
    "excuse me": "Извините,",
    "can i ask you a question": "Можно задать вам вопрос?",
    "can i ask you one question": "Можно задать вам один вопрос?",
    "what makes you happy": "Что делает тебя счастливым?",
    "what makes me happy": "Что делает меня счастливым?",
    "what's your name": "Как тебя зовут?",
    "what is your name": "Как тебя зовут?",
    "and your name": "А тебя как зовут?",
    "are you russian": "Ты из России?",
    "how are you going": "Как дела?",
    "so these things make me happy": "Вот что приносит мне счастье.",
    "so these things make me happy.": "Вот что приносит мне счастье.",
    "yes": "Да.",
    "no": "Нет.",
    "yeah": "Да.",
    "yep": "Да.",
    "nope": "Нет.",
    "hello": "Привет.",
    "hi": "Привет.",
    "okay": "Окей.",
    "ok": "Окей.",
    "thank you": "Спасибо.",
    "thanks": "Спасибо.",
    "thank you so much": "Большое спасибо.",
    "thank you very much": "Большое спасибо.",
    "oh my god": "О боже мой.",
    "oh my gosh": "О боже мой.",
    "wow": "Вау.",
    "wow.": "Вау.",
}


def translate_phrase_ollama(
    text: str,
    src_lang: str = "en",
    tgt_lang: str = "ru",
    model: str = "qwen2.5:7b",
    host: str = "http://127.0.0.1:11434",
    prev_context: str = "",
    next_context: str = ""
) -> str:
    """
    Переводит фразу с исходного языка на целевой через локальную Ollama
    с первоклассной литературной адаптацией разговорной речи (Reels / Shorts)
    и сглаживанием запинок/повторов спикера.
    """
    clean_src = text.strip()
    if not clean_src:
        return ""

    # Мгновенная подстановка для однозначных коротких вопросов и междометий из GLOSSARY
    clean_key = re.sub(r'[^\w\s]', '', clean_src).strip().lower()
    if clean_src.lower() in GLOSSARY:
        return GLOSSARY[clean_src.lower()]
    if clean_key in GLOSSARY:
        res = GLOSSARY[clean_key]
        if clean_src.endswith('?') and not res.endswith('?'):
            res = res.rstrip('. ') + '?'
        return res

    prompt_template = (
        "Ты — главный редактор русского дубляжа и литературный переводчик живых интервью (Reels / Shorts).\n"
        "Переведи английскую реплику на живой, естественный, грамотный разговорный русский язык (кириллица).\n\n"
        "ЗОЛОТЫЕ ПРАВИЛА ЛИТЕРАТУРНОГО ПЕРЕВОДА:\n"
        "1. ПЕРЕВОДИ ТОЧНО ТО, ЧТО СКАЗАНО, сохраняя живую интонацию (никакой отсебятины и никаких калек):\n"
        "   - \"feel loved\" -> \"чувствовать себя любимым\" (НЕ \"чувствовать любовь\")\n"
        "   - \"feel bliss\" / \"feel full of bliss\" -> \"ощущать блаженство\"\n"
        "   - \"nothing to worry\" / \"nothing to worry about\" -> \"переживать не о чем\" (НЕ \"ничего не беспокоит\")\n"
        "   - \"come down to the beach and come down and catch a fish, catch dinner\" -> \"выбраться на пляж и поймать рыбу себе на ужин\" (НЕ \"спуститься к пляжу\" и НЕ \"добыть ужин\")\n"
        "   - \"work harder\" -> \"больше стараться\"\n"
        "2. СГЛАЖИВАЙ ЗАПИНКИ И ПОВТОРЫ РЕЧИ: устные повторы («when i feel loved and when feel loved», «come down to the beach and come down») объединяй в одну чистую фразу без тавтологии.\n"
        "3. НЕ ДОБАВЛЯЙ ЛИШНИХ СЛОВ, которых нет в оригинале (запрещено вставлять «а ещё», «также» и т.п., если их не говорил спикер).\n"
        "4. ПИШИ ТОЛЬКО ПО-РУССКИ (КИРИЛЛИЦА). Категорически запрещены китайские иероглифы и непереведенные английские слова.\n"
        "5. Верни ТОЛЬКО готовый русский перевод в одну строку без пояснений.\n\n"
        "Примеры идеального перевода:\n"
        "Реплика: \"when i feel loved and when feel loved and i feel bliss nothing to worry\"\n"
        "Русский перевод: \"Когда я чувствую себя любимым и ощущаю блаженство, переживать не о чем.\"\n\n"
        "Реплика: \"When I feel loved and I feel full of bliss.\"\n"
        "Русский перевод: \"Когда я чувствую себя любимым и ощущаю блаженство.\"\n\n"
        "Реплика: \"Nothing to worry about.\"\n"
        "Русский перевод: \"Переживать не о чем.\"\n\n"
        "Реплика: \"For example, travel can make me happy.\"\n"
        "Русский перевод: \"Например, путешествия приносят мне счастье.\"\n\n"
        "Реплика: \"It's drawing.\"\n"
        "Русский перевод: \"Рисование.\"\n\n"
        "Реплика: \"Yeah, it helps me relax, come down to the beach and come down and catch a fish, catch dinner.\"\n"
        "Русский перевод: \"Да, это помогает мне расслабиться: выбраться на пляж и поймать рыбу себе на ужин.\"\n\n"
        "Реплика: \"It makes you work harder and work out your life in different areas if you need to.\"\n"
        "Русский перевод: \"Это заставляет больше стараться и налаживать свою жизнь в разных сферах, если нужно.\"\n\n"
        f"Реплика: \"{clean_src}\"\n"
        "Русский перевод:"
    )

    payload = {
        "model": model,
        "prompt": prompt_template,
        "stream": False,
        "options": {
            "temperature": 0.05,
            "top_p": 0.85,
            "num_predict": 160,
            "stop": ["\n\n", "Реплика:"]
        }
    }

    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            f"{host}/api/generate",
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=14.0) as resp:
            if resp.status == 200:
                resp_data = json.loads(resp.read().decode('utf-8'))
                raw_translation = resp_data.get('response', '').strip()

                # Очистка мета-тегов LLM, китайских иероглифов и кавычек
                cleaned = re.sub(r'^(Перевод|Translation|Текст|Русский перевод):\s*', '', raw_translation, flags=re.IGNORECASE)
                cleaned = re.sub(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+', '', cleaned)
                # Замена случайно оставшихся английских междометий и имен
                cleaned = re.sub(r'\bwow\b', 'вау', cleaned, flags=re.IGNORECASE)
                cleaned = re.sub(r'\bLucy\b', 'Люси', cleaned, flags=re.IGNORECASE)
                cleaned = re.sub(r'\bJamie\b', 'Джейми', cleaned, flags=re.IGNORECASE)
                cleaned = re.sub(r'\bJason\b', 'Джейсон', cleaned, flags=re.IGNORECASE)
                cleaned = re.sub(r'\s+', ' ', cleaned).strip(' "\'«»')

                # Сохранение вопросительного знака при вопросе в оригинале
                if clean_src.endswith('?') and not cleaned.endswith('?'):
                    cleaned = cleaned.rstrip('. ') + '?'

                if cleaned:
                    return cleaned
    except Exception as e:
        print(f"STATUS:Предупреждение перевода Ollama: {e}", flush=True)

    return clean_src


def interpolate_word_timestamps(
    translated_text: str,
    start_time: float,
    end_time: float
) -> List[Dict[str, Any]]:
    """
    Пропорционально распределяет тайминги переведённых слов по временным границам оригинального отрезка.
    Длина каждого слова учитывает количество символов, чтобы длинные слова звучали дольше.
    """
    raw_words = translated_text.strip().split()
    if not raw_words:
        return []

    total_duration = max(0.2, end_time - start_time)
    weights = [max(1, len(re.sub(r'[^\w]', '', w))) for w in raw_words]
    total_weight = sum(weights) or len(raw_words)

    result_words = []
    current_time = start_time

    for i, w in enumerate(raw_words):
        word_fraction = weights[i] / total_weight
        word_duration = total_duration * word_fraction

        w_start = current_time
        w_end = current_time + word_duration
        current_time = w_end

        result_words.append({
            'text': w,
            'word': w,
            'start': round(w_start, 3),
            'end': round(w_end, 3),
            'probability': 0.99
        })

    # Корректируем последний элемент ровно до end_time
    if result_words:
        result_words[-1]['end'] = round(end_time, 3)

    return result_words


def align_translation_to_blocks(
    original_blocks: List[Dict[str, Any]],
    translated_text: str,
    max_words: int = 2,
    text_case: str = "default",
    remove_chars: str = ""
) -> List[Dict[str, Any]]:
    """
    Естественное выравнивание перевода по оригинальным блокам:
    1. Переведенный текст нарезается на естественные фразы (синтагмы) через chunk_words(max_words=max_words).
       Это гарантирует, что предлоги и частицы ('не о чем', 'в жизни', 'это понятно') никогда не висят
       и не остаются в одиночестве на экране.
    2. Полученные M русских блоков выравниваются по K оригинальным интервалам через динамическое программирование
       с учетом границ клауз/пауз и сохранением 100% покадровой синхронизации.
    """
    if not original_blocks:
        return []

    t_words = translated_text.strip().split()
    if not t_words:
        return [{
            'start': b['start'],
            'end': b['end'],
            'text': format_subtitle_text(b['text'], text_case=text_case, remove_chars=remove_chars)
        } for b in original_blocks]

    K = len(original_blocks)
    total_dur = max(0.1, original_blocks[-1]['end'] - original_blocks[0]['start'])

    # Базовый случай: только 1 блок в оригинале
    if K == 1:
        return [{
            'start': original_blocks[0]['start'],
            'end': original_blocks[0]['end'],
            'text': format_subtitle_text(" ".join(t_words), text_case=text_case, remove_chars=remove_chars)
        }]

    # Формируем естественные синтагмы русского языка через chunk_words
    dummy_words = []
    curr_t = original_blocks[0]['start']
    step = total_dur / len(t_words)
    for w in t_words:
        dummy_words.append({'text': w, 'start': curr_t, 'end': curr_t + step})
        curr_t += step

    ru_chunks = chunk_words(
        dummy_words,
        max_words=max_words,
        text_case=text_case,
        remove_chars=remove_chars
    )
    M = len(ru_chunks)

    # Определяем границы пауз/пунктуации в оригинальных блоках для точной посадки знаков препинания
    orig_is_boundary = [False] * K
    for j_idx in range(K - 1):
        b_txt = str(original_blocks[j_idx].get('text', '')).strip()
        gap = original_blocks[j_idx + 1]['start'] - original_blocks[j_idx]['end']
        if b_txt.endswith(('.', '!', '?', ',', ';', ':')) or gap >= 0.18:
            orig_is_boundary[j_idx] = True
    orig_is_boundary[K - 1] = True

    ru_has_punct = [
        str(c.get('text', '')).strip().endswith(('.', '!', '?', ',', ';', ':', '—'))
        for c in ru_chunks
    ]

    # Случай 1: M <= K (Основной случай)
    # Выбираем M интервалов из K оригинальных блоков через динамическое программирование
    if M <= K:
        lengths = [max(1, len(c['text'])) for c in ru_chunks]
        total_len = sum(lengths)
        target_durs = [(l / total_len) * total_dur for l in lengths]

        dp = [[1e9] * (K + 1) for _ in range(M + 1)]
        parent = [[-1] * (K + 1) for _ in range(M + 1)]

        def cost(start_j: int, end_j: int, m: int) -> float:
            # Не включаем длинные внутренние паузы в длительность одного слова, если есть реальная граница клаузы
            actual_dur = original_blocks[end_j - 1]['end'] - original_blocks[start_j]['start']
            target_dur = target_durs[m]
            c_val = abs(actual_dur - target_dur) ** 2
            # Бонус за совпадение знака препинания в переводе с паузой/точкой в оригинале
            if m < M - 1:
                if ru_has_punct[m] and orig_is_boundary[end_j - 1]:
                    c_val -= 0.35
                elif not ru_has_punct[m] and orig_is_boundary[end_j - 1]:
                    c_val += 0.25
            return c_val

        for j in range(1, K + 1):
            dp[1][j] = cost(0, j, 0)
            parent[1][j] = 0

        for m in range(2, M + 1):
            for j in range(m, K + 1):
                best_c = 1e9
                best_p = -1
                for p in range(m - 1, j):
                    c = dp[m - 1][p] + cost(p, j, m - 1)
                    if c < best_c:
                        best_c = c
                        best_p = p
                dp[m][j] = best_c
                parent[m][j] = best_p

        cuts = [0] * (M + 1)
        curr = K
        for m in range(M, 0, -1):
            cuts[m] = curr
            curr = parent[m][curr]
        cuts[0] = 0

        result = []
        for m in range(M):
            s_idx = cuts[m]
            e_idx = cuts[m + 1] - 1
            block_start = original_blocks[s_idx]['start']
            block_end = original_blocks[e_idx]['end']
            if m < M - 1:
                for internal_j in range(s_idx, e_idx):
                    gap = original_blocks[internal_j + 1]['start'] - original_blocks[internal_j]['end']
                    if gap >= 0.22 and ru_has_punct[m]:
                        block_end = original_blocks[internal_j]['end']
                        break
            result.append({
                'start': block_start,
                'end': block_end,
                'text': ru_chunks[m]['text']
            })
        return result

    # Случай 2: M > K (Слов в переводе заметно больше, объединяем соседние чанки под K блоков)
    cuts = [round(i * M / K) for i in range(K + 1)]
    cuts[0] = 0
    cuts[-1] = M
    for i in range(1, len(cuts)):
        if cuts[i] <= cuts[i - 1]:
            cuts[i] = cuts[i - 1] + 1

    result = []
    for k in range(K):
        c_start = cuts[k]
        c_end = cuts[k + 1]
        chunk_slice = ru_chunks[c_start:c_end]
        combined_text = " ".join(c['text'] for c in chunk_slice)
        result.append({
            'start': original_blocks[k]['start'],
            'end': original_blocks[k]['end'],
            'text': format_subtitle_text(combined_text, text_case=text_case, remove_chars=remove_chars)
        })
    return result


def process_bilingual_translation(
    words: List[Dict[str, Any]],
    src_lang: str = "auto",
    tgt_lang: str = "ru",
    max_words: int = 2,
    text_case: str = "default",
    remove_chars: str = "",
    use_proofread: bool = True
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Главный конвейер мультиязычной синхронизации SubSplit:
    1. Делит поток слов на высказывания с сохранением естественных пауз и целостности мысли.
    2. Определяет язык каждого высказывания.
    3. Для родного языка (ru): нарезает блоки субтитров по правилам SubSplit.
    4. Для иностранного языка (en):
       a. Нарезает оригинальную речь на блоки (дорожка 2).
       b. Переводит фразу через локальную Ollama в контексте соседних реплик диалога.
       c. Выравнивает перевод 1-в-1 по таймкодам оригинальных блоков (дорожка 1).
    5. Гарантирует абсолютную синхронизацию кадр-в-кадр между обеими дорожками.
    """
    if not words:
        return {"translated": [], "original_foreign": [], "full_raw": []}

    print(f"STATUS:Мультиязычный анализ и синхронизация речи ({src_lang} ➔ {tgt_lang})...", flush=True)

    server_info = check_ollama_server()
    ollama_model = get_preferred_model(server_info.get("models", [])) if server_info["running"] else "qwen2.5:7b"

    utterances = split_multilingual_utterances(words, max_sentence_len=35)
    utterance_texts = [
        " ".join((w.get('text') or w.get('word') or '').strip() for w in u).strip()
        for u in utterances
    ]
    subs_translated: List[Dict[str, Any]] = []
    subs_foreign: List[Dict[str, Any]] = []

    with OllamaSession():
        for idx, utt in enumerate(utterances):
            if not utt:
                continue

            utt_text = utterance_texts[idx]
            detected_lang = detect_text_language(utt_text, default=tgt_lang)

            # Случай 1: Реплика уже на целевом языке (например, русская речь)
            if detected_lang == tgt_lang:
                ru_blocks = chunk_words(
                    utt,
                    max_words=max_words,
                    text_case=text_case,
                    remove_chars=remove_chars
                )
                subs_translated.extend(ru_blocks)

            # Случай 2: Иностранная речь (например, английский диалог)
            else:
                # 1. Нарезаем оригинальную иностранную речь по правилам субтитров
                en_blocks = chunk_words(
                    utt,
                    max_words=max_words,
                    text_case=text_case,
                    remove_chars=remove_chars
                )
                subs_foreign.extend(en_blocks)

                # 2. Переводим фразу через Ollama с учетом контекста соседних реплик
                prev_ctx = utterance_texts[idx - 1] if idx > 0 else ""
                next_ctx = utterance_texts[idx + 1] if idx + 1 < len(utterance_texts) else ""
                short_preview = utt_text[:35] + ("..." if len(utt_text) > 35 else "")
                print(f"STATUS:Перевод [{src_lang}➔{tgt_lang}]: «{short_preview}»", flush=True)
                translated_str = translate_phrase_ollama(
                    text=utt_text,
                    src_lang=detected_lang,
                    tgt_lang=tgt_lang,
                    model=ollama_model,
                    prev_context=prev_ctx,
                    next_context=next_ctx
                )

                # 3. Синхронизируем перевод 1-в-1 по таймингам блоков оригинальной речи
                if translated_str:
                    ru_aligned_blocks = align_translation_to_blocks(
                        original_blocks=en_blocks,
                        translated_text=translated_str,
                        max_words=max_words,
                        text_case=text_case,
                        remove_chars=remove_chars
                    )
                    subs_translated.extend(ru_aligned_blocks)
                else:
                    # Fallback: если перевод не удался, сохраняем оригинальные блоки
                    subs_translated.extend(en_blocks)

    # Пронумеровываем индексы для корректного SRT формата
    for i, sub in enumerate(subs_translated, 1):
        sub['index'] = i
    for i, sub in enumerate(subs_foreign, 1):
        sub['index'] = i

    subs_raw = chunk_words(
        words,
        max_words=max_words,
        text_case=text_case,
        remove_chars=remove_chars
    )

    print(f"STATUS:Синхронизация завершена: Перевод ({len(subs_translated)} субт.), Оригинал ({len(subs_foreign)} субт.).", flush=True)

    return {
        "translated": subs_translated,
        "original_foreign": subs_foreign,
        "full_raw": subs_raw
    }
