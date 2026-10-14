"""
Chunker module: Implements dynamic programming subtitle segmentation
strictly enforcing Russian typography rules:
1. Configurable max words per subtitle block.
2. Prepositions and hanging particles MUST NEVER end a subtitle block.
3. Prepositions must be attached to the following word at the start of the next subtitle.
4. Short proclitic chains (e.g. "и в какой-то", "как и все") are attached to the content word.
5. Conversational idioms ("ну что", "то есть") and proper names ("Кента Кума") are never torn apart.
6. Hyphenated suffixes ("-то", "-нибудь", "-таки") are merged with their base word (no "и в какой" / "-то момент").
7. Subtitle blocks must never contain 0 content words (e.g. never isolate "и в" alone).
8. Customizable text case (UPPERCASE, lowercase, default).
9. Configurable punctuation removal (all, or specific signs like .,?!).
"""

import re
from typing import List, Dict, Any

# Полный список русских предлогов, союзов и проклитик,
# которые никогда не должны висеть в конце строки перед зависимым словом:
HANGING_WORDS = {
    # Простые предлоги
    "в", "во", "на", "с", "со", "из", "изо", "к", "ко", "от", "ото", "по",
    "о", "об", "обо", "у", "за", "под", "подо", "над", "надо", "при", "про",
    "для", "без", "безо", "до", "сквозь", "через", "чрез", "меж", "между",
    "среди", "возле", "около", "ради", "вокруг", "после", "кроме",
    # Частицы и союзы (проклитики)
    "не", "ни", "а", "и", "но", "да", "или", "либо", "как", "что", "чтоб", "чтобы", "даже"
}

# Постпозитивные частицы (энклитики) и суффиксы - фонетически и синтаксически тяготеют
# к ПРЕДЫДУЩЕМУ слову и НИКОГДА не могут начинать новую строку субтитров:
ENCLITICS = {"же", "ж", "ли", "ль", "бы", "б", "ка", "де", "таки", "то", "нибудь", "либо"}

# Служебные слова (предлоги, союзы, частицы, связки) без самостоятельного лексического ударения
FUNCTION_WORDS = HANGING_WORDS | ENCLITICS | {"ну", "уж", "вот", "вон", "ведь", "то", "это", "лишь", "также"}

# Неопределенные местоимения и наречия, требующие дефиса с постфиксами
HYPHEN_PRONOUNS = {
    "какой", "какая", "какое", "какие", "каком", "какую", "каких", "каким", "какими",
    "кто", "кого", "кому", "кем", "ком",
    "что", "чего", "чему", "чем",
    "где", "куда", "откуда", "когда", "как", "почему", "зачем",
    "чей", "чья", "чье", "чьи", "чьего", "чьей", "чьих", "чьим", "чьими", "чьем",
    "сколько", "скольких", "скольким", "сколькими",
    "кое"
}

HYPHEN_POSTFIXES = {"то", "нибудь", "либо", "ка", "таки", "де"}

# Устойчивые составные союзы, обороты и словосочетания, которые нельзя разрывать:
COMPOUND_PAIRS = {
    # Разговорные фразы и вводные обороты
    ("ну", "что"),
    ("ну", "и"),
    ("ну", "как"),
    ("ну", "вот"),
    ("ну", "да"),
    ("ну", "же"),
    ("да", "и"),
    ("так", "что"),
    ("так", "же"),
    ("такая", "же"),
    ("такой", "же"),
    ("такое", "же"),
    ("такие", "же"),
    ("тот", "же"),
    ("то", "же"),
    ("тоже", "самое"),
    ("как", "и"),
    ("так", "и"),
    ("то", "есть"),
    ("не", "только"),
    ("но", "и"),
    ("потому", "что"),
    ("так", "как"),
    ("оттого", "что"),
    ("из", "за"),
    ("из", "под"),
    ("всё", "равно"),
    ("все", "равно"),
    ("всё", "же"),
    ("все", "же"),
    ("всё", "ещё"),
    ("все", "еще"),
    ("друг", "друга"),
    ("друг", "другу"),
    ("друг", "другом"),
    ("до", "сих"),
    ("сих", "пор"),
    ("если", "бы"),
    ("хотя", "бы"),
    ("вряд", "ли"),
    ("навряд", "ли"),
    ("как", "раз"),
    ("до", "того"),
    ("с", "тех"),
    ("к", "тому"),
    ("тем", "не"),
    ("не", "менее"),
    ("не", "о"),
    ("ни", "о"),
    ("о", "чем"),
    ("а", "что"),
    ("и", "что"),
    ("в", "том"),
    ("вместе", "с"),
    ("рядом", "с"),
    ("по", "крайней"),
    ("крайней", "мере"),
    ("в", "общем"),
    ("на", "самом"),
    ("самом", "деле"),
    ("кстати", "говоря"),
}

# Составные пары, которые имеют право заканчивать чанк, даже если их 2-е слово в HANGING_WORDS
ALLOWED_HANGING_END_PAIRS = {
    ("ну", "что"),
    ("ну", "и"),
    ("а", "что"),
    ("и", "что"),
    ("так", "что"),
    ("да", "и"),
    ("как", "и"),
    ("так", "и"),
    ("то", "есть"),
    ("потому", "что"),
    ("так", "как"),
    ("но", "и"),
    ("если", "бы"),
    ("хотя", "бы"),
    ("тем", "не"),
    ("в", "том"),
}


_STRIP_PUNCT = ' \t\n\r.,!?:;—–-"\'«»()[]{}*`~…'
_SENTENCE_END_PUNCT = ('.', '!', '?', '…')
_CLAUSE_BOUNDARY_PUNCT = (',', ';', ':', '—', '–', '-')
_HANGING_DASHES = ("-", "—", "–")
_ALL_PUNCT_RE = re.compile(r'[,.!?…:;—–"\'«»]')
_WHITESPACE_RE = re.compile(r'\s+')


def clean_word(w: str) -> str:
    """Очищает слово от знаков препинания, приводит к нижнему регистру и нормализует ё/е."""
    if not w:
        return ""
    stripped = w.strip(_STRIP_PUNCT)
    if not stripped:
        return ""
    return stripped.lower().replace('ё', 'е')


def is_capitalized(w: str) -> bool:
    """Проверяет, начинается ли слово с заглавной буквы (имя, фамилия, бренд)."""
    if not w:
        return False
    cleaned = w.strip(_STRIP_PUNCT)
    if len(cleaned) < 2:
        return False
    return cleaned[0].isupper() and cleaned[1:].islower()


def is_proper_noun_pair(w1: str, w2: str) -> bool:
    """Проверяет, образуют ли два соседних слова имя собственное (Кента Кума, Илон Маск)."""
    if has_sentence_end_punctuation(w1) or has_clause_boundary(w1):
        return False
    return is_capitalized(w1) and is_capitalized(w2)


def is_hanging(w: str) -> bool:
    """Проверяет, является ли слово висячим предлогом/союзом или незавершенным словом с дефисом."""
    if not w:
        return False
    stripped = w.strip()
    if stripped.endswith("-") and len(stripped) > 1:
        return True
    return clean_word(w) in HANGING_WORDS


def is_enclitic(w: str) -> bool:
    """Проверяет, является ли слово постпозитивной частицей (энклитикой) или суффиксом."""
    if not w:
        return False
    stripped = w.strip()
    if stripped.startswith("-") and clean_word(w) in HYPHEN_POSTFIXES:
        return True
    return clean_word(w) in ENCLITICS


def is_function_word(w: str) -> bool:
    """Проверяет, является ли слово служебным (предлог, союз, частица без собственного ударения)."""
    return clean_word(w) in FUNCTION_WORDS


def is_compound_pair(w1: str, w2: str) -> bool:
    """Проверяет, образуют ли два соседних слова неделимую составную пару."""
    return (clean_word(w1), clean_word(w2)) in COMPOUND_PAIRS


def allows_hanging_end(w1: str, w2: str) -> bool:
    """Разрешено ли паре заканчивать блок субтитров."""
    return (clean_word(w1), clean_word(w2)) in ALLOWED_HANGING_END_PAIRS


def has_sentence_end_punctuation(w: str) -> bool:
    """Проверяет, заканчивается ли слово точкой, вопросительным или восклицательным знаком."""
    if not w:
        return False
    return w.rstrip(' "»\'').endswith(_SENTENCE_END_PUNCT)


def has_clause_boundary(w: str) -> bool:
    """Проверяет знаки препинания, разделяющие клаузы/синтагмы: запятая, двоеточие, тире."""
    if not w:
        return False
    return w.rstrip(' "»\'').endswith(_CLAUSE_BOUNDARY_PUNCT)


_HYPHEN_PREFIXES = {
    "по", "во", "в", "из", "пол", "полу", "кое", "все", "всё",
    "чуть", "еле", "точь", "вице", "экс", "мини", "макси", "топ", "веб", "само"
}
_FALSE_HYPHEN_RE = re.compile(
    r'^([А-Яа-яЁё]{3,})[-—–](это|то|не|все|всё|как|что|вот|же)([,.!?…:;]*)$',
    re.IGNORECASE
)


def merge_broken_tokens(words: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Склеивает разорванные дефисные токены ('какой' + '-то' -> 'какой-то')
    и разъединяет ложные дефисные склейки тире ('счастье-это' -> 'счастье —' + 'это').
    """
    if not words:
        return []

    # 0. Предварительно разделяем ложные склейки вида "счастье-это" или одиночные тире
    expanded: List[Dict[str, Any]] = []
    for item in words:
        txt = item.get("text", "").strip()
        if not txt:
            continue
        # Если токен — это просто отдельное тире "-" или "—", приклеиваем его к предыдущему слову
        if txt in ("-", "—", "–") and expanded:
            prev_t = expanded[-1]["text"].rstrip()
            if not prev_t.endswith(_CLAUSE_BOUNDARY_PUNCT) and not prev_t.endswith(_SENTENCE_END_PUNCT):
                expanded[-1]["text"] = prev_t + " —"
                expanded[-1]["end"] = max(expanded[-1]["end"], item.get("end", expanded[-1]["end"]))
            continue

        m = _FALSE_HYPHEN_RE.match(txt)
        if m:
            p1, p2, tail_punct = m.group(1), m.group(2), m.group(3)
            c1_low = p1.lower().replace('ё', 'е')
            c2_low = p2.lower().replace('ё', 'е')
            # Если это НЕ местоимение с постфиксом ("какой-то", "что-то", "всё-таки")
            if not (c1_low in HYPHEN_PRONOUNS and c2_low in HYPHEN_POSTFIXES) and c1_low not in _HYPHEN_PREFIXES:
                s_t = float(item.get("start", 0.0))
                e_t = float(item.get("end", s_t + 0.2))
                mid_t = round(s_t + (e_t - s_t) * 0.6, 3)
                w1 = dict(item)
                w1["text"] = p1 + " —"
                w1["word"] = w1["text"]
                w1["end"] = mid_t
                w2 = dict(item)
                w2["text"] = p2 + tail_punct
                w2["word"] = w2["text"]
                w2["start"] = mid_t
                expanded.append(w1)
                expanded.append(w2)
                continue

        expanded.append(dict(item))

    merged = []
    i = 0
    n = len(expanded)

    while i < n:
        curr = dict(expanded[i])
        while i + 1 < n:
            next_w = expanded[i + 1]
            t1 = curr["text"].strip()
            t2 = next_w["text"].strip()

            if t1.rstrip(' "»\'').endswith(_SENTENCE_END_PUNCT):
                break

            c1 = clean_word(t1)
            c2 = clean_word(t2)

            should_merge = False
            sep = ""
            t2_clean = t2

            is_valid_hyphen_pair = (
                c2 in HYPHEN_POSTFIXES
                or c1 in HYPHEN_PRONOUNS
                or c1 in _HYPHEN_PREFIXES
                or (c1 == c2 and len(c1) >= 2)
            )

            # 1. Английские апострофы: "I" + "'m" -> "I'm", "what" + "'s" -> "what's"
            if t2.startswith(("'", "’")):
                should_merge = True
                sep = ""
                t2_clean = t2
            # 2. Валидное дефисное слово, разорванное на 2 токена ("какой-" + "то" или "какой" + "-то")
            elif (t1.endswith("-") or t2.startswith("-")) and is_valid_hyphen_pair:
                should_merge = True
                t1_base = t1.rstrip("-—– ")
                curr["text"] = t1_base
                t1 = t1_base
                sep = "-"
                t2_clean = t2.lstrip("-—– ")
            # 3. Если второй токен начинается с тире ("- это", "— это"), но это НЕ дефисный суффикс:
            # переносим тире к первому слову как пунктуацию ("счастье —") и НЕ склеиваем слова!
            elif t2.startswith(_HANGING_DASHES) and not is_valid_hyphen_pair:
                stripped_t2 = t2.lstrip("-—– ").strip()
                if stripped_t2:
                    if not t1.endswith(_CLAUSE_BOUNDARY_PUNCT):
                        curr["text"] = t1 + " —"
                    expanded[i + 1]["text"] = stripped_t2
                    expanded[i + 1]["word"] = stripped_t2
                break
            # 4. Местоимение + постфикс без дефиса: "какой" + "то" -> "какой-то"
            elif c1 in HYPHEN_PRONOUNS and c2 in HYPHEN_POSTFIXES:
                should_merge = True
                sep = "-"
                t2_clean = t2
            # 5. "из" + "за" / "под" -> "из-за" / "из-под"
            elif c1 == "из" and c2 in {"за", "под"}:
                should_merge = True
                sep = "-"
                t2_clean = t2
            # 6. "все/всё" + "таки" -> "всё-таки"
            elif c1 in {"все", "всё"} and c2 in {"таки", "-таки"}:
                should_merge = True
                sep = "-"
                t2_clean = t2.lstrip("-—–")

            if should_merge:
                curr["text"] = t1 + sep + t2_clean
                curr["word"] = curr["text"]
                curr["end"] = next_w["end"]
                i += 1
            else:
                break

        merged.append(curr)
        i += 1

    return merged


def format_subtitle_text(text: str, text_case: str = "default", remove_chars: str = "") -> str:
    """
    Применяет настройки стиля:
    - remove_chars: "all" (удаляет всю пунктуацию) или строка символов, например ".," или "?!"
    - text_case: "upper" (все прописные), "lower" (все строчные), "default" (как в речи)
    """
    if remove_chars:
        if "all" in remove_chars or set(".,?!").issubset(set(remove_chars)):
            text = _ALL_PUNCT_RE.sub('', text)
        else:
            for ch in remove_chars:
                text = text.replace(ch, '')
        text = _WHITESPACE_RE.sub(' ', text).strip()

    if text_case == "upper":
        text = text.upper()
    elif text_case == "lower":
        text = text.lower()

    return text


def balance_text_lines(text: str, max_lines: int = 2) -> str:
    """Форматирует строку субтитров в 1, 2 или 3 сбалансированные строки без висячих предлогов."""
    tokens = text.split()
    if len(tokens) <= 1 or max_lines <= 1:
        return " ".join(tokens)

    # Если текст короткий и свободно влезает в одну строку, не разбиваем принудительно
    if len(text) <= 18:
        return " ".join(tokens)

    if max_lines == 2:
        best_i = -1
        best_diff = 999999
        for i in range(1, len(tokens)):
            # Не разрываем в конце строки предлоги
            if is_hanging(tokens[i - 1]):
                continue
            l1 = " ".join(tokens[:i])
            l2 = " ".join(tokens[i:])
            diff = abs(len(l1) - len(l2))
            if diff < best_diff:
                best_diff = diff
                best_i = i
        if best_i == -1:
            return " ".join(tokens)
        return " ".join(tokens[:best_i]) + "\n" + " ".join(tokens[best_i:])
    elif max_lines >= 3:
        if len(tokens) <= 2:
            return " ".join(tokens)
        best_i, best_j = -1, -1
        best_diff = 999999
        for i in range(1, len(tokens) - 1):
            if is_hanging(tokens[i - 1]):
                continue
            for j in range(i + 1, len(tokens)):
                if is_hanging(tokens[j - 1]):
                    continue
                l1 = " ".join(tokens[:i])
                l2 = " ".join(tokens[i:j])
                l3 = " ".join(tokens[j:])
                diff = max(len(l1), len(l2), len(l3)) - min(len(l1), len(l2), len(l3))
                if diff < best_diff:
                    best_diff = diff
                    best_i = i
                    best_j = j
        if best_i == -1 or best_j == -1:
            return " ".join(tokens)
        return " ".join(tokens[:best_i]) + "\n" + " ".join(tokens[best_i:best_j]) + "\n" + " ".join(tokens[best_j:])
    return text


def chunk_words(
    words_with_timing: List[Dict[str, Any]],
    max_words: int = 2,
    max_lines: int = 2,
    text_case: str = "default",
    remove_chars: str = ""
) -> List[Dict[str, Any]]:
    """
    Разбивает список слов с таймингами на блоки субтитров:
    - Базовый максимум max_words слов на экран (по умолчанию 2 для Reels).
    - Ни один блок не заканчивается на предлог (при max_words > 1).
    - Ни один блок не начинается с энклитики (же, ли, бы, -то, -нибудь).
    - Блоки не могут состоять исключительно из предлогов (запрет одиночных "и в").
    - Предлоги связываются со следующим словом ("и в какой-то" вместо "и в" + "какой-то").
    - Склейка разорванных дефисных токенов ("какой-то" вместо "какой" + "-то").
    - Разговорные фразы ("ну что") и имена собственные ("Кента Кума") не разрываются.
    - Быстрый DP-алгоритм со сжатыми предрасчитанными свойствами слов (O(1) проверки).
    """
    if not words_with_timing:
        return []

    # 1. Склеиваем разорванные токены Whisper ("какой" + "-то" -> "какой-то")
    words_with_timing = merge_broken_tokens(words_with_timing)

    n = len(words_with_timing)
    if n == 0:
        return []

    # 2. Предварительный расчет свойств слов в один проход O(N)
    texts = [w['text'] for w in words_with_timing]
    cleans = [clean_word(t) for t in texts]
    is_hangs = [is_hanging(t) for t in texts]
    is_encls = [is_enclitic(t) for t in texts]
    is_funcs = [c in FUNCTION_WORDS for c in cleans]
    starts = [w['start'] for w in words_with_timing]
    ends = [w['end'] for w in words_with_timing]
    has_sent_ends = [has_sentence_end_punctuation(t) for t in texts]
    has_clause_bounds = [has_clause_boundary(t) for t in texts]

    # Предварительный расчет связей соседних слов (i, i+1)
    is_compound = [False] * (n - 1)
    is_proper = [False] * (n - 1)
    allows_hanging_pair = [False] * (n - 1)

    for j in range(n - 1):
        c1, c2 = cleans[j], cleans[j + 1]
        is_compound[j] = (c1, c2) in COMPOUND_PAIRS
        allows_hanging_pair[j] = (c1, c2) in ALLOWED_HANGING_END_PAIRS
        if not (has_sent_ends[j] or has_clause_bounds[j]):
            is_proper[j] = is_capitalized(texts[j]) and is_capitalized(texts[j + 1])

    # 3. Динамическое программирование (без аллокаций строк в цикле)
    dp = [float('inf')] * (n + 1)
    choice = [1] * (n + 1)
    dp[n] = 0

    for i in range(n - 1, -1, -1):
        max_k = max(max_words + 1, 3)

        for k in range(max_k, 0, -1):
            if i + k > n:
                continue

            num_content = 0
            for idx in range(i, i + k):
                if not is_funcs[idx]:
                    num_content += 1

            if k > max_words:
                starts_short_proclitic = is_hangs[i] and len(cleans[i]) <= 3
                if k >= max_words + 2:
                    starts_short_proclitic = starts_short_proclitic and is_hangs[i + 1] and len(cleans[i + 1]) <= 3
                raw_len = sum(len(texts[idx]) for idx in range(i, i + k)) + (k - 1)
                allowed_content_limit = max(1, max_words - 1)
                if not (starts_short_proclitic and num_content <= allowed_content_limit and raw_len <= 28):
                    continue

            cost = 0

            # Правило 0: Запрет субтитров из одних предлогов (0 содержательных слов)
            if num_content == 0:
                if k >= 2 and is_compound[i]:
                    pass
                else:
                    cost += 2_000_000

            # Правило 1: Чанк НЕ может начинаться с энклитики (же, ли, бы, -то и др.)
            if i > 0 and is_encls[i]:
                cost += 1_000_000

            # Правило 2: Запрет висячего предлога/союза в конце блока
            if i + k < n and is_hangs[i + k - 1]:
                if k >= 2 and allows_hanging_pair[i + k - 2]:
                    pass
                else:
                    cost += 1_000_000

            # Правило 3: Бонус за неделимую составную пару или имя внутри блока
            for j in range(i, i + k - 1):
                if is_compound[j]:
                    cost -= 250
                if is_proper[j]:
                    cost -= 300

            # Правило 4: Штраф за разрыв пары или имени на границе блоков
            if i + k < n:
                if is_compound[i + k - 1]:
                    cost += 500_000
                if is_proper[i + k - 1]:
                    cost += 500_000

            # Правило 5: Предпочтение заполненности блоков
            if k < max_words:
                cost += (max_words - k) * 8
                if i < n - 1 and is_hangs[i] and max_words > 1:
                    cost += 500_000

            # Правило 6: Бонус за предлог в начале блока
            if k > 1 and is_hangs[i]:
                cost -= 20

            # Правило 7: Границы синтагм и пунктуация внутри блока
            for idx in range(i, i + k - 1):
                if has_sent_ends[idx]:
                    cost += 300
                elif has_clause_bounds[idx]:
                    cost += 100
                if starts[idx + 1] - ends[idx] > 0.45:
                    cost += 80

            total_cost = cost + dp[i + k]
            if total_cost < dp[i]:
                dp[i] = total_cost
                choice[i] = k

    # 4. Восстановление оптимального разбиения
    subtitles = []
    curr = 0
    while curr < n:
        k = choice[curr]
        chunk = words_with_timing[curr : curr + k]
        raw_text = " ".join(w['text'].strip() for w in chunk)
        styled_text = format_subtitle_text(raw_text, text_case=text_case, remove_chars=remove_chars)
        if max_lines == 1:
            styled_text = styled_text.replace("\n", " ").replace("\r", " ")
        else:
            styled_text = balance_text_lines(styled_text, max_lines=max_lines)

        subtitles.append({
            'index': len(subtitles) + 1,
            'text': styled_text,
            'start': chunk[0]['start'],
            'end': chunk[-1]['end'],
            'words': chunk,
            'max_lines': max_lines
        })
        curr += k

    # 5. Сглаживание микропауз (чтобы субтитры не мерцали)
    for i in range(len(subtitles) - 1):
        gap = subtitles[i + 1]['start'] - subtitles[i]['end']
        if 0 < gap < 0.15:
            subtitles[i]['end'] = round(subtitles[i + 1]['start'] - 0.02, 3)

    return subtitles
